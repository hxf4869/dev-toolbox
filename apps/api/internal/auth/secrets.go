package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/hxf4869/dev-toolbox/apps/api/internal/platform/secretbox"
)

func randomToken() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(random), nil
}

func tokenHash(token string) []byte {
	hash := sha256.Sum256([]byte(token))
	return hash[:]
}

func csrfToken(masterKey []byte, sessionToken string) string {
	hasher := hmac.New(sha256.New, masterKey)
	hasher.Write([]byte("csrf:v1:"))
	hasher.Write([]byte(sessionToken))
	return base64.RawURLEncoding.EncodeToString(hasher.Sum(nil))
}

func encryptSecret(masterKey []byte, plaintext string) ([]byte, error) {
	return secretbox.Seal(masterKey, plaintext)
}

func decryptSecret(masterKey, ciphertext []byte) (string, error) {
	return secretbox.Open(masterKey, ciphertext)
}

func generateRecoveryCodes(count int) ([]string, []string, error) {
	plaintext := make([]string, 0, count)
	hashes := make([]string, 0, count)
	for range count {
		random := make([]byte, 10)
		if _, err := rand.Read(random); err != nil {
			return nil, nil, fmt.Errorf("generate recovery code: %w", err)
		}
		encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(random)
		code := strings.Join([]string{encoded[0:4], encoded[4:8], encoded[8:12], encoded[12:16]}, "-")
		plaintext = append(plaintext, code)
		hashes = append(hashes, recoveryCodeHash(code))
	}
	return plaintext, hashes, nil
}

func normalizeRecoveryCode(code string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
}

func recoveryCodeHash(code string) string {
	hash := sha256.Sum256([]byte("recovery:v1:" + normalizeRecoveryCode(code)))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}
