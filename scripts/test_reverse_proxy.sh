#!/bin/bash

# Reverse proxy verification script
# Run on the production server after installing Caddy

echo "🧪 Reverse Proxy Health Check"
echo "=============================="

DOMAIN=${1:-"api.example.com"}
echo "🌐 Target domain: $DOMAIN"
echo ""

# Check HTTP response code
check_endpoint() {
    local url=$1
    local expected_code=${2:-200}
    local description=$3
    
    echo -n "🔍 $description: "
    
    response=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$url" 2>/dev/null)
    
    if [ "$response" = "$expected_code" ]; then
        echo "✅ $response"
        return 0
    else
        echo "❌ $response (expected $expected_code)"
        return 1
    fi
}

# Check redirect target
check_redirect() {
    local url=$1
    local expected_location=$2
    local description=$3
    
    echo -n "🔀 $description: "
    
    location=$(curl -s -I -m 10 "$url" | grep -i "location:" | awk '{print $2}' | tr -d '\r\n')
    
    if [[ "$location" == *"$expected_location"* ]]; then
        echo "✅ $location"
        return 0
    else
        echo "❌ $location (expected $expected_location)"
        return 1
    fi
}

echo "📋 Core endpoints check:"
echo "------------------------"

# HTTPS redirect check
check_redirect "http://$DOMAIN" "https://$DOMAIN" "HTTP → HTTPS redirect"

# Core endpoints
check_endpoint "https://$DOMAIN/api/health/liveness" 200 "Health Liveness"
check_endpoint "https://$DOMAIN/api/health/readiness" 200 "Health Readiness"

# Metrics must be blocked
check_endpoint "https://$DOMAIN/api/metrics" 403 "Metrics (must be blocked)"

# Swagger must be disabled in prod
check_endpoint "https://$DOMAIN/api/docs" 404 "Swagger Docs (must be unavailable)"

# Root redirect
check_redirect "https://$DOMAIN/" "https://$DOMAIN/api/docs" "Root redirect"

# WWW redirect
check_redirect "http://www.$DOMAIN" "https://$DOMAIN" "WWW redirect"

echo ""
echo "🔒 Security headers check:"
echo "--------------------------"

# Security header helper
headers_check() {
    local header=$1
    local description=$2
    
    echo -n "🛡️  $description: "
    
    header_value=$(curl -s -I -m 10 "https://$DOMAIN/api/health/liveness" | grep -i "$header" | awk -F': ' '{print $2}' | tr -d '\r\n')
    
    if [ -n "$header_value" ]; then
        echo "✅ $header_value"
    else
        echo "❌ Missing"
    fi
}

headers_check "X-Content-Type-Options" "X-Content-Type-Options"
headers_check "X-Frame-Options" "X-Frame-Options"
headers_check "Strict-Transport-Security" "HSTS"

echo ""
echo "📊 SSL certificate check:"
echo "-------------------------"

# SSL certificate
echo -n "🔐 SSL certificate: "
ssl_info=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null)

if [ $? -eq 0 ]; then
    echo "✅ Valid"
    echo "   $(echo "$ssl_info" | grep "issuer")"
    echo "   $(echo "$ssl_info" | grep "notAfter")"
else
    echo "❌ Certificate problem"
fi

echo ""
echo "🎯 Performance check:"
echo "---------------------"

# Response time
echo -n "⚡ API response time: "
response_time=$(curl -o /dev/null -s -w "%{time_total}s" "https://$DOMAIN/api/health/liveness")
echo "$response_time"

echo ""
echo "📝 Caddy logs (last 10 lines):"
echo "------------------------------"

if [ -f "/var/log/caddy/api.log" ]; then
    tail -n 10 /var/log/caddy/api.log
else
    echo "❌ Log file not found: /var/log/caddy/api.log"
fi

echo ""
echo "🔍 Caddy service status:"
echo "------------------------"
systemctl status caddy --no-pager -l | head -n 10

echo ""
echo "✅ Check completed!"
echo "If all tests passed, the reverse proxy is configured correctly."
