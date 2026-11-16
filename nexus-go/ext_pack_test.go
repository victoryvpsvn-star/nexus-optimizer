// ext_pack_test.go — tự verify CRX3 theo đúng thuật toán verifier của Chromium:
// parse header protobuf, kiểm tra chữ ký RSA-PKCS1-SHA256 trên
// "CRX3 SignedData" || LE32(len(shd)) || shd || zip, kiểm tra ID a-p, zip + manifest key.
package main

import (
	"archive/zip"
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"testing"
)

// đọc một trường protobuf varint-tag + length-delimited tại offset; trả về (field, data, nextOffset)
func pbNext(b []byte, off int) (int, []byte, int, error) {
	shift := uint(0)
	var tag uint64
	for {
		if off >= len(b) {
			return 0, nil, 0, io.ErrUnexpectedEOF
		}
		c := b[off]
		off++
		tag |= uint64(c&0x7f) << shift
		shift += 7
		if c&0x80 == 0 {
			break
		}
	}
	if tag&0x7 != 2 {
		return 0, nil, 0, io.ErrUnexpectedEOF
	}
	var ln uint64
	shift = 0
	for {
		if off >= len(b) {
			return 0, nil, 0, io.ErrUnexpectedEOF
		}
		c := b[off]
		off++
		ln |= uint64(c&0x7f) << shift
		shift += 7
		if c&0x80 == 0 {
			break
		}
	}
	if off+int(ln) > len(b) {
		return 0, nil, 0, io.ErrUnexpectedEOF
	}
	return int(tag >> 3), b[off : off+int(ln)], off + int(ln), nil
}

func pbFields(t *testing.T, msg []byte) map[int][]byte {
	t.Helper()
	out := map[int][]byte{}
	off := 0
	for off < len(msg) {
		f, d, no, err := pbNext(msg, off)
		if err != nil {
			t.Fatalf("protobuf parse: %v", err)
		}
		out[f] = d
		off = no
	}
	return out
}

func TestCRX3PackAndSelfVerify(t *testing.T) {
	crx, id, err := packExtCRX()
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	if len(id) != 32 {
		t.Fatalf("ID dài %d ≠ 32", len(id))
	}
	for _, c := range id {
		if c < 'a' || c > 'p' {
			t.Fatalf("ID có ký tự ngoài a-p: %q", string(c))
		}
	}
	if !bytes.HasPrefix(crx, []byte("Cr24")) {
		t.Fatal("magic sai")
	}
	if v := binary.LittleEndian.Uint32(crx[4:8]); v != 3 {
		t.Fatalf("version %d ≠ 3", v)
	}
	headerLen := binary.LittleEndian.Uint32(crx[8:12])
	if int(12+headerLen) > len(crx) {
		t.Fatal("header_size tràn file")
	}
	header := crx[12 : 12+headerLen]
	zipBytes := crx[12+headerLen:]

	hf := pbFields(t, header)
	proof, ok := hf[2]
	if !ok {
		t.Fatal("không có proof sha256_with_rsa (field 2)")
	}
	shd, ok := hf[10000]
	if !ok {
		t.Fatal("không có signed_header_data (field 10000)")
	}
	pf := pbFields(t, proof)
	spki, sig := pf[1], pf[2]
	if len(spki) == 0 || len(sig) != 256 {
		t.Fatalf("proof sai: spki=%d sig=%d", len(spki), len(sig))
	}
	// SignedData phải chứa crx_id = SHA256(spki)[:16]
	sdf := pbFields(t, shd)
	sum := sha256.Sum256(spki)
	if !bytes.Equal(sdf[1], sum[:16]) {
		t.Fatal("crx_id trong SignedData ≠ SHA256(spki)[:16]")
	}
	// xác minh chữ ký đúng như crx_verifier.cc của Chromium
	signed := append([]byte("CRX3 SignedData"), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(signed[15:19], uint32(len(shd)))
	signed = append(signed, shd...)
	signed = append(signed, zipBytes...)
	pub, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		t.Fatalf("spki: %v", err)
	}
	d := sha256.Sum256(signed)
	if err := rsa.VerifyPKCS1v15(pub.(*rsa.PublicKey), crypto.SHA256, d[:], sig); err != nil {
		t.Fatalf("chữ ký CRX3 không hợp lệ: %v", err)
	}
	if got := extIDFromSPKI(spki); got != id {
		t.Fatalf("ID không khớp: %s ≠ %s", got, id)
	}
	// zip bên trong: manifest có key khớp + đủ 7 file
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("zip: %v", err)
	}
	if len(zr.File) != 7 {
		t.Fatalf("zip có %d file ≠ 7", len(zr.File))
	}
	mf, err := zr.Open("manifest.json")
	if err != nil {
		t.Fatalf("thiếu manifest.json: %v", err)
	}
	defer mf.Close()
	var man map[string]any
	if err := json.NewDecoder(mf).Decode(&man); err != nil {
		t.Fatalf("manifest hỏng: %v", err)
	}
	if man["key"] != base64.StdEncoding.EncodeToString(spki) {
		t.Fatal("manifest key ≠ khoá ký CRX")
	}
	if man["version"] != "2.2.1" {
		t.Fatalf("version = %v ≠ 2.2.1", man["version"])
	}
	// gọi lần 2 phải ra cache giống hệt
	crx2, id2, err := packExtCRX()
	if err != nil || !bytes.Equal(crx, crx2) || id2 != id {
		t.Fatal("cache pack lần 2 lệch")
	}
}
