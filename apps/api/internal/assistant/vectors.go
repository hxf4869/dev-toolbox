package assistant

import (
	"math"

	"github.com/pgvector/pgvector-go"
)

// vectorFor converts an embedding payload into the pgvector type registered on
// the pool by the integrator's AfterConnect hook.
func vectorFor(values []float32) pgvector.Vector {
	return pgvector.NewVector(values)
}

func finiteFloat32(value float32) bool {
	return !math.IsInf(float64(value), 0) && !math.IsNaN(float64(value))
}
