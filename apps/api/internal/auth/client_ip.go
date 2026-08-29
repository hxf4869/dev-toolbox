package auth

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

func parseTrustedProxyCIDRs(value string) ([]*net.IPNet, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	var networks []*net.IPNet
	for _, raw := range strings.Split(value, ",") {
		_, network, err := net.ParseCIDR(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("parse trusted proxy CIDR: %w", err)
		}
		networks = append(networks, network)
	}
	return networks, nil
}

func clientIP(request *http.Request, trustedProxies []*net.IPNet) net.IP {
	remoteHost, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		remoteHost = request.RemoteAddr
	}
	remoteIP := net.ParseIP(strings.TrimSpace(remoteHost))
	if remoteIP == nil || !ipInNetworks(remoteIP, trustedProxies) {
		return remoteIP
	}
	for _, forwarded := range strings.Split(request.Header.Get("X-Forwarded-For"), ",") {
		if parsed := net.ParseIP(strings.TrimSpace(forwarded)); parsed != nil {
			return parsed
		}
	}
	return remoteIP
}

func ipInNetworks(ip net.IP, networks []*net.IPNet) bool {
	for _, network := range networks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
