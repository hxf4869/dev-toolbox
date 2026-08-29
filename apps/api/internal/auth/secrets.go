package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
)

const encryptedSecretVersion byte = 1

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
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	output := make([]byte, 1, 1+len(nonce)+len(plaintext)+gcm.Overhead())
	output[0] = encryptedSecretVersion
	output = append(output, nonce...)
	output = gcm.Seal(output, nonce, []byte(plaintext), []byte("dev-toolbox:secret:v1"))
	return output, nil
}

func decryptSecret(masterKey, ciphertext []byte) (string, error) {
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}
	if len(ciphertext) < 1+gcm.NonceSize()+gcm.Overhead() || ciphertext[0] != encryptedSecretVersion {
		return "", errors.New("invalid encrypted secret")
	}
	nonce := ciphertext[1 : 1+gcm.NonceSize()]
	plaintext, err := gcm.Open(nil, nonce, ciphertext[1+gcm.NonceSize():], []byte("dev-toolbox:secret:v1"))
	if err != nil {
		return "", errors.New("decrypt secret")
	}
	return string(plaintext), nil
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
