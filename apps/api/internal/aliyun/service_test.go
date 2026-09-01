package aliyun

import (
	"context"
	"testing"
	"time"
)

func TestSettlementContextSurvivesRequestCancellation(t *testing.T) {
	requestContext, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()

	ctx, cancel := settlementContext(requestContext)
	defer cancel()
	if err := ctx.Err(); err != nil {
		t.Fatalf("settlement context inherited request cancellation: %v", err)
	}
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > settlementDeadline {
		t.Fatalf("settlement context has an invalid deadline: %v, %v", deadline, ok)
	}
}
