// ext_pack.go — đóng gói extension Cat Status thành CRX3 tự ký (kiểu Kaspersky: không
// để source rải ra folder, Chrome cài im lặng qua policy). Format CRX3 đối chiếu thẳng
// source Chromium 120 (crx_verifier.cc): chữ ký RSA-PKCS1-SHA256 =
// "CRX3 SignedData" || LE32(len(signed_header_data)) || signed_header_data || [zip].
// Extension ID = SHA256(SPKI DER)[:16] hex → alphabet a-p (id_util.cc GenerateId).
package main

import (
	"archive/zip"
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

var extCacheMtx sync.Mutex
var extCacheCRX []byte
var extCacheID string
var extPort int // được set từ main sau khi Listen

func extSetPort(p int) { extPort = p }

func extDataDir() string { return filepath.Dir(presenceConfigPath()) }

/** Khoá RSA cho CRX: tạo lần đầu, lưu ext-key.pem trong thư mục dữ liệu */
func extKey() (*rsa.PrivateKey, error) {
	path := filepath.Join(extDataDir(), "ext-key.pem")
	if b, err := os.ReadFile(path); err == nil {
		if blk, _ := pem.Decode(b); blk != nil {
			if k, e := x509.ParsePKCS1PrivateKey(blk.Bytes); e == nil {
				return k, nil
			}
		}
	}
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	_ = os.MkdirAll(extDataDir(), 0o700)
	b := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

func extIDFromSPKI(spki []byte) string {
	sum := sha256.Sum256(spki)
	id := make([]byte, 32)
	for i := 0; i < 16; i++ {
		id[2*i] = byte('a' + (sum[i] >> 4))
		id[2*i+1] = byte('a' + (sum[i] & 0x0f))
	}
	return string(id)
}

// ---------- protobuf căn bản cho CrxFileHeader ----------

func pbVarint(v uint64) []byte {
	var b []byte
	for {
		x := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b = append(b, x|0x80)
		} else {
			b = append(b, x)
			break
		}
	}
	return b
}

func pbBytes(field int, v []byte) []byte {
	out := pbVarint(uint64(field)<<3 | 2)
	out = append(out, pbVarint(uint64(len(v)))...)
	return append(out, v...)
}

/** Zip extension: ghi đè manifest key = khoá của ta (CRX bắt buộc khớp) + version 2.2.1 */
func extZip(spki []byte) ([]byte, error) {
	manRaw, err := fs.ReadFile(catStatusFS, "extension/cat-status/manifest.json")
	if err != nil {
		return nil, err
	}
	var man map[string]any
	if err := json.Unmarshal(manRaw, &man); err != nil {
		return nil, err
	}
	man["key"] = base64.StdEncoding.EncodeToString(spki)
	man["version"] = "2.2.1"
	manNew, _ := json.Marshal(man)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err = fs.WalkDir(catStatusFS, "extension/cat-status", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel("extension/cat-status", p)
		w, err := zw.Create(rel)
		if err != nil {
			return err
		}
		if rel == "manifest.json" {
			_, err = w.Write(manNew)
		} else {
			var b []byte
			b, err = fs.ReadFile(catStatusFS, p)
			if err == nil {
				_, err = w.Write(b)
			}
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

/** Đóng gói CRX3; trả về (bytes, extensionID, err) */
func packExtCRX() ([]byte, string, error) {
	extCacheMtx.Lock()
	defer extCacheMtx.Unlock()
	if extCacheCRX != nil {
		return extCacheCRX, extCacheID, nil
	}
	key, err := extKey()
	if err != nil {
		return nil, "", err
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, "", err
	}
	id := extIDFromSPKI(spki)
	crxID := sha256.Sum256(spki)
	shd := pbBytes(1, crxID[:16])
	zipBytes, err := extZip(spki)
	if err != nil {
		return nil, "", err
	}
	// signed payload = "CRX3 SignedData" || LE32(len(shd)) || shd || zip
	sp := []byte("CRX3 SignedData")
	var l32 [4]byte
	binary.LittleEndian.PutUint32(l32[:], uint32(len(shd)))
	sp = append(sp, l32[:]...)
	sp = append(sp, shd...)
	sp = append(sp, zipBytes...)
	digest := sha256.Sum256(sp)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return nil, "", err
	}
	proof := append(pbBytes(1, spki), pbBytes(2, sig)...)
	header := append(pbBytes(2, proof), pbBytes(10000, shd)...)
	out := []byte("Cr24")
	var v32, h32 [4]byte
	binary.LittleEndian.PutUint32(v32[:], 3)
	binary.LittleEndian.PutUint32(h32[:], uint32(len(header)))
	out = append(out, v32[:]...)
	out = append(out, h32[:]...)
	out = append(out, header...)
	out = append(out, zipBytes...)
	extCacheCRX, extCacheID = out, id
	return out, id, nil
}

// ---------- HTTP handlers + URL cho policy ----------

func extUpdateURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/ext/update.xml", extPort)
}

func extSourcePattern() string {
	return fmt.Sprintf("http://127.0.0.1:%d/ext/*", extPort)
}

func extCrxURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/ext/cat-status.crx", extPort)
}

type gupdateAppXML struct {
	AppID string `xml:"appid,attr"`
}

func handleExtUpdateXML(w http.ResponseWriter, r *http.Request) {
	_, id, err := packExtCRX()
	if err != nil {
		http.Error(w, "pack lỗi: "+err.Error(), 500)
		return
	}
	_ = gupdateAppXML{} // giữ struct XML cho lần mở rộng sau
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>`+"\n"+
		`<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">`+"\n"+
		"  <app appid=%q>\n"+
		"    <updatecheck codebase=%q version=%q />\n"+
		"  </app>\n"+
		`</gupdate>`+"\n", id, extCrxURL(), "2.2.1")
}

func handleExtCrx(w http.ResponseWriter, r *http.Request) {
	crx, _, err := packExtCRX()
	if err != nil {
		http.Error(w, "pack lỗi: "+err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="cat-status.crx"`)
	w.Header().Set("Content-Length", fmt.Sprint(len(crx)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, "")
	_, _ = w.Write(crx)
}
