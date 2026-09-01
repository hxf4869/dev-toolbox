package assistant

import "context"

// SensitivePolicyChangeHook is wired by the integrator to
// (*Service).NotifySensitivePolicyChanged so a global sensitive_ai_policy
// change bumps the embedding generation. It lives on the ai package to avoid
// an import cycle while keeping the assistant module the only owner of the
// generation semantics.
type SensitivePolicyChangeHook = func(ctx context.Context, previous, current string) error

// NotifySensitivePolicyChanged bumps the embedding generation whenever the
// global sensitive AI policy changes; tightening first clears derived vectors.
// It is registered by main.go after both services exist:
//
//	ai.SensitivePolicyChangeHook = assistantService.NotifySensitivePolicyChanged
func (service *Service) NotifySensitivePolicyChanged(ctx context.Context, previous, current string) error {
	if previous == current {
		return nil
	}
	return service.bumpGenerationForPolicyChange(ctx, previous, current, service.now().UTC())
}
