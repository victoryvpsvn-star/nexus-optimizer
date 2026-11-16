//go:build !windows

// ext_policy_other.go — stub cho Linux/macOS: policy auto-install extension là cơ chế
// registry của Windows; Linux/macOS dùng nút "Load unpacked" thường.
package main

import "fmt"

func extPolicyInstall() (string, error) {
	return "", fmt.Errorf("cài qua policy chỉ hỗ trợ Windows (Chrome/Edge đọc policy từ registry HKCU). Trên nền này dùng nút 'Tự cài đặt extension' rồi Load unpacked.")
}

func extPolicyRemove() (string, error) {
	return "", fmt.Errorf("không có policy nào trên nền này")
}

func extPolicyAutoReapply() {}
