package auth

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image/png"
	"net/url"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

type TOTPProvisioning struct {
	Secret          string `json:"manualKey"`
	ProvisioningURI string `json:"provisioningUri"`
	QRCodeDataURL   string `json:"qrCodeDataUrl"`
}

func newTOTP(username string) (TOTPProvisioning, error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "开发百宝箱",
		AccountName: username,
		Period:      30,
		SecretSize:  20,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return TOTPProvisioning{}, fmt.Errorf("generate TOTP: %w", err)
	}
	return provisioningFromKey(key)
}

func provisioningFromSecret(username, secret string) (TOTPProvisioning, error) {
	issuer := "开发百宝箱"
	provisioningURL := &url.URL{Scheme: "otpauth", Host: "totp", Path: "/" + issuer + ":" + username}
	query := provisioningURL.Query()
	query.Set("algorithm", "SHA1")
	query.Set("digits", "6")
	query.Set("issuer", issuer)
	query.Set("period", "30")
	query.Set("secret", secret)
	provisioningURL.RawQuery = query.Encode()
	key, err := otp.NewKeyFromURL(provisioningURL.String())
	if err != nil {
		return TOTPProvisioning{}, fmt.Errorf("restore TOTP provisioning: %w", err)
	}
	return provisioningFromKey(key)
}

func provisioningFromKey(key *otp.Key) (TOTPProvisioning, error) {
	qrImage, err := key.Image(220, 220)
	if err != nil {
		return TOTPProvisioning{}, fmt.Errorf("render TOTP QR: %w", err)
	}
	var qr bytes.Buffer
	if err := png.Encode(&qr, qrImage); err != nil {
		return TOTPProvisioning{}, fmt.Errorf("encode TOTP QR: %w", err)
	}
	return TOTPProvisioning{
		Secret:          key.Secret(),
		ProvisioningURI: key.URL(),
		QRCodeDataURL:   "data:image/png;base64," + base64.StdEncoding.EncodeToString(qr.Bytes()),
	}, nil
}

func validateTOTP(secret, code string, now time.Time) bool {
	valid, err := totp.ValidateCustom(code, secret, now, totp.ValidateOpts{
		Period:    30,
		Skew:      1,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	return err == nil && valid
}
