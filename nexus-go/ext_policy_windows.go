//go:build windows

// ext_policy_windows.go — cài extension kiểu Kaspersky: ghi policy HKCU của Chrome/Edge
// (ExtensionSettings: force_installed + update_url tự host; ExtensionInstallSources cho phép
// nguồn http://127.0.0.1). Chrome sẽ tự tải + cài CRX im lặng, hiện "Được quản trị".
package main

import (
	"encoding/json"
	"fmt"

	"golang.org/x/sys/windows/registry"
)

const extPolicySettings = `ExtensionSettings`
const extPolicySources = `ExtensionInstallSources`

func extPolicyParams() (string, string, string) {
	_, id, _ := packExtCRX()
	data, _ := json.Marshal(map[string]string{
		"installation_mode": "force_installed",
		"update_url":        extUpdateURL(),
	})
	return id, string(data), extSourcePattern()
}

/** Ghi policy cho cả Chrome + Edge (HKCU — không cần admin) */
func extPolicyInstall() (string, error) {
	id, settings, src := extPolicyParams()
	msg := ""
	for _, root := range []string{`SOFTWARE\Policies\Google\Chrome`, `SOFTWARE\Policies\Microsoft\Edge`} {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, root+`\`+extPolicySettings, registry.SET_VALUE)
		if err != nil {
			return msg, fmt.Errorf("tạo policy ExtensionSettings lỗi: %w", err)
		}
		if err := k.SetStringValue(id, settings); err != nil {
			k.Close()
			return msg, err
		}
		k.Close()
		k2, _, err := registry.CreateKey(registry.CURRENT_USER, root+`\`+extPolicySources, registry.SET_VALUE)
		if err != nil {
			return msg, fmt.Errorf("tạo policy ExtensionInstallSources lỗi: %w", err)
		}
		if err := k2.SetStringValue("1", src); err != nil {
			k2.Close()
			return msg, err
		}
		k2.Close()
		msg += "✓ " + root + "\n"
	}
	c := presenceCfgLoad()
	c.PolicyEnabled = true
	c.PolicyPort = extPort
	_ = presenceCfgSave(c)
	return "Đã ghi policy (Chrome + Edge, HKCU):\n" + msg +
		"Extension ID: " + id + "\n" +
		"KHÔNG ĐÓNG tool (Chrome cần tải CRX từ tool). Restart Chrome/Edge → extension tự hiện,\n" +
		"gạch 'Được quản trị', không thể gỡ tay. Gỡ = nút Gỡ policy trong tool.", nil
}

/** Xoá policy (extension biến mất ở lần restart Chrome tiếp theo) */
func extPolicyRemove() (string, error) {
	id, _, src := extPolicyParams()
	msg := "Đã xoá policy:\n"
	for _, root := range []string{`SOFTWARE\Policies\Google\Chrome`, `SOFTWARE\Policies\Microsoft\Edge`} {
		if k, err := registry.OpenKey(registry.CURRENT_USER, root+`\`+extPolicySettings, registry.SET_VALUE); err == nil {
			_ = k.DeleteValue(id)
			k.Close()
		}
		if k, err := registry.OpenKey(registry.CURRENT_USER, root+`\`+extPolicySources, registry.SET_VALUE); err == nil {
			if v, _, _ := k.GetStringValue("1"); v == src {
				_ = k.DeleteValue("1")
			}
			k.Close()
		}
		msg += "✓ " + root + "\n"
	}
	c := presenceCfgLoad()
	c.PolicyEnabled = false
	_ = presenceCfgSave(c)
	return msg + "Restart Chrome/Edge để extension bị gỡ.", nil
}

/** Chạy nền sau khởi động: nếu tool đổi cổng mà policy còn trỏ cổng cũ → ghi lại */
func extPolicyAutoReapply() {
	c := presenceCfgLoad()
	if c.PolicyEnabled && c.PolicyPort != extPort && extPort > 0 {
		_, _ = extPolicyInstall()
	}
}
