package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
)

const envelopeVersion byte = 1

var envelopeAAD = []byte("dev-toolbox:secret:v1")

// Seal stores a secret in the application's versioned AES-GCM envelope.
// Callers remain responsible for keeping plaintext out of logs and responses.
func Seal(masterKey []byte, plaintext string) ([]byte, error) {
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
	output[0] = envelopeVersion
	output = append(output, nonce...)
	output = gcm.Seal(output, nonce, []byte(plaintext), envelopeAAD)
	return output, nil
}

func Open(masterKey, ciphertext []byte) (string, error) {
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}
	if len(ciphertext) < 1+gcm.NonceSize()+gcm.Overhead() || ciphertext[0] != envelopeVersion {
		return "", errors.New("invalid encrypted secret")
	}
	nonce := ciphertext[1 : 1+gcm.NonceSize()]
	plaintext, err := gcm.Open(nil, nonce, ciphertext[1+gcm.NonceSize():], envelopeAAD)
	if err != nil {
		return "", errors.New("decrypt secret")
	}
	return string(plaintext), nil
}
