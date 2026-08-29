package secretbox

import (
	"bytes"
	"testing"
)

func TestSealOpenVersionedEnvelope(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	first, err := Seal(key, "provider-secret")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Seal(key, "provider-secret")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) {
		t.Fatal("randomized envelopes must not repeat")
	}
	if first[0] != envelopeVersion || bytes.Contains(first, []byte("provider-secret")) {
		t.Fatal("envelope version or confidentiality invariant failed")
	}
	plaintext, err := Open(key, first)
	if err != nil || plaintext != "provider-secret" {
		t.Fatalf("round trip failed: %q %v", plaintext, err)
	}
	first[len(first)-1] ^= 0xff
	if _, err := Open(key, first); err == nil {
		t.Fatal("tampered ciphertext must fail authentication")
	}
}
