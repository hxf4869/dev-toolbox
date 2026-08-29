package auth

import (
	"bytes"
	"strings"
	"testing"
)

func TestPasswordRoundTripPreservesWhitespace(t *testing.T) {
	password := "  Correct horse 电池 staple  "
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, password) {
		t.Fatal("expected password to verify")
	}
	if VerifyPassword(hash, password[2:]) {
		t.Fatal("password verification unexpectedly trimmed input")
	}
}

func TestProvisioningCanBeRestoredWithoutChangingSecret(t *testing.T) {
	initial, err := newTOTP("所有者 user")
	if err != nil {
		t.Fatal(err)
	}
	restored, err := provisioningFromSecret("所有者 user", initial.Secret)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Secret != initial.Secret {
		t.Fatal("restored provisioning changed the pending secret")
	}
	if !strings.Contains(restored.ProvisioningURI, "issuer=") || !strings.HasPrefix(restored.QRCodeDataURL, "data:image/png;base64,") {
		t.Fatal("restored provisioning is incomplete")
	}
}

func TestEncryptedSecretRoundTripAndTamperFailure(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	ciphertext, err := encryptSecret(key, "TOTPSECRET")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := decryptSecret(key, ciphertext)
	if err != nil || plaintext != "TOTPSECRET" {
		t.Fatalf("decrypt = %q, %v", plaintext, err)
	}
	ciphertext[len(ciphertext)-1] ^= 1
	if _, err := decryptSecret(key, ciphertext); err == nil {
		t.Fatal("expected tampered ciphertext to fail")
	}
}

func TestRecoveryCodesAreIndependentAndNormalized(t *testing.T) {
	codes, hashes, err := generateRecoveryCodes(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 10 || len(hashes) != 10 {
		t.Fatalf("code counts = %d/%d", len(codes), len(hashes))
	}
	seen := map[string]bool{}
	for index, code := range codes {
		if seen[hashes[index]] {
			t.Fatal("duplicate recovery code hash")
		}
		seen[hashes[index]] = true
		if recoveryCodeHash(normalizeRecoveryCode(code)) != hashes[index] {
			t.Fatal("normalized recovery code hash mismatch")
		}
	}
}
