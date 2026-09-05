#!/bin/bash

# Script to verify bibliaris.com availability after DNS and Caddy setup
# Can be run from a local machine or the server

set -euo pipefail

DOMAIN="bibliaris.com"
SERVER_IP="209.74.88.183"

echo "🔍 Checking availability of $DOMAIN"
echo "================================"

# Logging helpers
log() {
    echo "$(date '+%H:%M:%S') [INFO] $*"
}

log_success() {
    echo "$(date '+%H:%M:%S') [✅] $*"
}

log_error() {
    echo "$(date '+%H:%M:%S') [❌] $*"
}

log_warning() {
    echo "$(date '+%H:%M:%S') [⚠️] $*"
}

# DNS check
check_dns() {
    log "Checking DNS records..."
    
    # Check A-record
    dns_result=$(dig +short $DOMAIN A 2>/dev/null || echo "")
    
    if [[ "$dns_result" == "$SERVER_IP" ]]; then
        log_success "DNS A-record correct: $DOMAIN → $SERVER_IP"
        return 0
    elif [[ -n "$dns_result" ]]; then
        log_error "DNS A-record incorrect: $DOMAIN → $dns_result (expected $SERVER_IP)"
        return 1
    else
        log_error "DNS A-record not found for $DOMAIN"
        return 1
    fi
}

# Check server ports
check_ports() {
    log "Checking ports on server $SERVER_IP..."
    
    # Check port 80 (HTTP)
    if nc -z -w3 $SERVER_IP 80 2>/dev/null; then
        log_success "Port 80 (HTTP) open"
    else
        log_error "Port 80 (HTTP) unavailable"
        return 1
    fi
    
    # Check port 443 (HTTPS)
    if nc -z -w3 $SERVER_IP 443 2>/dev/null; then
        log_success "Port 443 (HTTPS) open"
    else
        log_error "Port 443 (HTTPS) unavailable"
        return 1
    fi
    
    return 0
}

# Check HTTP availability
check_http() {
    log "Checking HTTP availability..."

    # Check HTTP (should redirect to HTTPS)
    #
    # LEGACY-233: curl с -w '%{http_code}' печатает "000" САМ на отказе соединения,
    # поэтому `|| echo "000"` дописывал вторую "000" к уже напечатанной, и переменная
    # становилась "000000" - строкой, не совпадающей ни с одним ожиданием.
    #
    # `set +e`/`set -e` здесь несущие, а не косметика: под `set -euo pipefail` (шапка
    # файла) присваивание `x=$(curl ...)` без хвоста `||` завершает скрипт на первом
    # же отказе соединения - молча, до печати диагностики и до остальных проверок.
    # Тот же приём стоит в deploy.yml (шаг Verify Deployment).
    set +e
    http_response=$(curl -s -o /dev/null -w "%{http_code}" -L http://$DOMAIN/api/health/liveness 2>/dev/null)
    set -e

    if [[ "$http_response" == "200" ]]; then
        log_success "HTTP availability: $http_response"
    else
        log_warning "HTTP response: $http_response"
    fi
}

# Check HTTPS availability
check_https() {
    log "Checking HTTPS availability..."

    # Check HTTPS health endpoint
    set +e
    https_response=$(curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN/api/health/liveness 2>/dev/null)
    set -e

    if [[ "$https_response" == "200" ]]; then
        log_success "HTTPS API is working: $https_response"
    else
        log_error "HTTPS API unavailable: $https_response"
        return 1
    fi

    # Check main page
    set +e
    main_response=$(curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN/ 2>/dev/null)
    set -e
    log "Main page: $main_response"
    
    return 0
}

# Check SSL certificate
check_ssl() {
    log "Checking SSL certificate..."
    
    # Retrieve certificate info
    ssl_info=$(echo | openssl s_client -servername $DOMAIN -connect $DOMAIN:443 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null || echo "")
    
    if [[ -n "$ssl_info" ]]; then
        log_success "SSL certificate found:"
        echo "$ssl_info" | while IFS= read -r line; do
            echo "   $line"
        done
    else
        log_error "SSL certificate unavailable"
        return 1
    fi
    
    return 0
}

# Check specific endpoints
check_endpoints() {
    log "Checking API endpoints..."
    
    endpoints=(
        "/api/health/liveness"
        "/api/health/readiness"
    )
    
    for endpoint in "${endpoints[@]}"; do
        set +e
        response=$(curl -s -o /dev/null -w "%{http_code}" https://$DOMAIN$endpoint 2>/dev/null)
        set -e
        if [[ "$response" == "200" ]]; then
            log_success "$endpoint: $response"
        else
            log_error "$endpoint: $response"
        fi
    done
}

# Check response time
check_performance() {
    log "Checking performance..."

    # LEGACY-233, то же место другим write-out: curl печатает `%{time_total}` и при
    # отказе (время до обрыва), поэтому `|| echo "timeout"` давал склейку вида
    # `1.006494stimeout` - условие `!= "timeout"` истинно, и ветка предупреждения
    # была недостижима вовсе: отказ печатался строкой успеха. У времени, в отличие
    # от кода ответа, нет значения-маркера отказа, поэтому исход берётся из кода
    # возврата curl, а не из его вывода.
    set +e
    response_time=$(curl -o /dev/null -s -w "%{time_total}s" https://$DOMAIN/api/health/liveness 2>/dev/null)
    curl_status=$?
    set -e

    if [[ $curl_status -eq 0 ]]; then
        log "API response time: $response_time"
    else
        log_warning "Timeout while checking response time"
    fi
}

# Main check function
main() {
    local errors=0
    
    echo "🌐 Domain: $DOMAIN"
    echo "🖥️ Server: $SERVER_IP"
    echo "⏰ Time: $(date)"
    echo ""
    
    # Run all checks
    check_dns || errors=$((errors + 1))
    echo ""
    
    check_ports || errors=$((errors + 1))
    echo ""
    
    check_http
    echo ""
    
    check_https || errors=$((errors + 1))
    echo ""
    
    check_ssl || errors=$((errors + 1))
    echo ""
    
    check_endpoints
    echo ""
    
    check_performance
    echo ""
    
    # Final result
    if [[ $errors -eq 0 ]]; then
        log_success "All checks passed! 🎉"
        echo ""
        echo "✅ bibliaris.com is fully functional"
        echo "🔗 API available at: https://bibliaris.com/"
    else
        log_error "$errors error(s) detected"
        echo ""
        echo "📋 Possible causes:"
        echo "  - DNS changes haven't propagated yet (wait up to 48 hours)"
        echo "  - Caddy is not running on the server"
        echo "  - Firewall blocks ports 80/443"
        echo "  - Application not running on localhost:5000"
        echo ""
        echo "🔍 For server-side diagnostics:"
        echo "  systemctl status caddy"
        echo "  journalctl -u caddy -n 20"
        echo "  curl -I http://localhost:5000/api/health/liveness"
        
        return 1
    fi
}

# Dependency check
check_dependencies() {
    local missing_deps=()
    
    for cmd in dig curl nc openssl; do
        if ! command -v $cmd &> /dev/null; then
            missing_deps+=($cmd)
        fi
    done
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Required utilities not found: ${missing_deps[*]}"
        log "Install them with: sudo apt install dnsutils curl netcat-openbsd openssl"
        exit 1
    fi
}

# Run
check_dependencies
main "$@"
