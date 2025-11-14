#!/bin/bash

# Books App Monitoring Test Script
# Comprehensive verification of the monitoring stack

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Output helpers
log() {
    echo -e "${GREEN}[INFO] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}"
}

test_result() {
    local test_name="$1"
    local result="$2"
    local details="$3"
    
    ((TOTAL_TESTS++))
    
    if [[ "$result" == "PASS" ]]; then
        echo -e "${GREEN}✓ $test_name${NC}"
        ((PASSED_TESTS++))
    else
        echo -e "${RED}✗ $test_name${NC}"
        if [[ -n "$details" ]]; then
            echo -e "  ${RED}Details: $details${NC}"
        fi
        ((FAILED_TESTS++))
    fi
}

# Service availability check
check_service() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"
    
    if response=$(curl -s -w "%{http_code}" -o /dev/null "$url" 2>/dev/null); then
        if [[ "$response" == "$expected_status" ]]; then
            test_result "$name availability" "PASS"
            return 0
        else
            test_result "$name availability" "FAIL" "HTTP $response (expected $expected_status)"
            return 1
        fi
    else
    test_result "$name availability" "FAIL" "Connection failed"
        return 1
    fi
}

# Prometheus metrics checks
check_prometheus_metrics() {
    log "Checking Prometheus metrics..."
    
    local prometheus_url="http://localhost:${PROMETHEUS_PORT:-9090}"
    
    # Basic health endpoint
    if ! check_service "Prometheus" "$prometheus_url/-/healthy"; then
        return 1
    fi
    
    # Verify targets
    if targets=$(curl -s "$prometheus_url/api/v1/targets" 2>/dev/null); then
        if echo "$targets" | jq -e '.data.activeTargets[] | select(.job=="books-app")' > /dev/null 2>&1; then
            test_result "Prometheus target 'books-app'" "PASS"
        else
            test_result "Prometheus target 'books-app'" "FAIL" "Target not found or inactive"
        fi
        
        if echo "$targets" | jq -e '.data.activeTargets[] | select(.job=="node-exporter")' > /dev/null 2>&1; then
            test_result "Prometheus target 'node-exporter'" "PASS"
        else
            test_result "Prometheus target 'node-exporter'" "FAIL" "Target not found or inactive"
        fi
    else
    test_result "Prometheus API targets" "FAIL" "Failed to fetch targets list"
    fi
    
    # Check app 'up' metric
    if metrics=$(curl -s "$prometheus_url/api/v1/query?query=up{job=\"books-app\"}" 2>/dev/null); then
        if echo "$metrics" | jq -e '.data.result[0].value[1]' > /dev/null 2>&1; then
            local up_value=$(echo "$metrics" | jq -r '.data.result[0].value[1]')
            if [[ "$up_value" == "1" ]]; then
                test_result "Books App metrics" "PASS"
            else
                test_result "Books App metrics" "FAIL" "Application reports down (value: $up_value)"
            fi
        else
            test_result "Books App metrics" "FAIL" "Metric 'up' not found"
        fi
    else
    test_result "Prometheus API query" "FAIL" "Failed to execute query"
    fi
}

# Grafana checks
check_grafana() {
    log "Checking Grafana..."
    
    local grafana_url="http://localhost:${GRAFANA_PORT:-3000}"
    
    # Basic health endpoint
    if ! check_service "Grafana" "$grafana_url/api/health"; then
        return 1
    fi
    
    # Verify datasources
    local auth_header="Authorization: Basic $(echo -n "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-admin123}" | base64)"
    
    if datasources=$(curl -s -H "$auth_header" "$grafana_url/api/datasources" 2>/dev/null); then
        if echo "$datasources" | jq -e '.[] | select(.name=="Prometheus")' > /dev/null 2>&1; then
            test_result "Grafana datasource Prometheus" "PASS"
        else
            test_result "Grafana datasource Prometheus" "FAIL" "Datasource not configured"
        fi
    else
    test_result "Grafana API datasources" "FAIL" "Failed to fetch datasources"
    fi
    
    # Check dashboards
    if dashboards=$(curl -s -H "$auth_header" "$grafana_url/api/search?type=dash-db" 2>/dev/null); then
        local dashboard_count=$(echo "$dashboards" | jq length 2>/dev/null || echo "0")
        if [[ "$dashboard_count" -gt 0 ]]; then
            test_result "Grafana dashboards" "PASS" "Found $dashboard_count dashboard(s)"
        else
            test_result "Grafana dashboards" "FAIL" "No dashboards found"
        fi
    else
    test_result "Grafana API dashboards" "FAIL" "Failed to fetch dashboards"
    fi
}

# AlertManager checks
check_alertmanager() {
    log "Checking AlertManager..."
    
    local alertmanager_url="http://localhost:${ALERTMANAGER_PORT:-9093}"
    
    # Basic health endpoint
    if ! check_service "AlertManager" "$alertmanager_url/-/healthy"; then
        return 1
    fi
    
    # Status check
    if status=$(curl -s "$alertmanager_url/api/v1/status" 2>/dev/null); then
        if echo "$status" | jq -e '.status=="success"' > /dev/null 2>&1; then
            test_result "AlertManager status" "PASS"
        else
            test_result "AlertManager status" "FAIL" "Status not 'success'"
        fi
    else
    test_result "AlertManager API status" "FAIL" "Failed to fetch status"
    fi
    
    # Configuration retrieval
    if config=$(curl -s "$alertmanager_url/api/v1/status" 2>/dev/null); then
    test_result "AlertManager configuration" "PASS"
    else
    test_result "AlertManager configuration" "FAIL" "Failed to fetch configuration"
    fi
}

# Node Exporter checks
check_node_exporter() {
    log "Checking Node Exporter..."
    
    local node_exporter_url="http://localhost:${NODE_EXPORTER_PORT:-9100}"
    
    # Basic metrics scrape
    if ! check_service "Node Exporter" "$node_exporter_url/metrics"; then
        return 1
    fi
    
    # Check key metrics presence
    if metrics=$(curl -s "$node_exporter_url/metrics" 2>/dev/null); then
        local key_metrics=("node_cpu_seconds_total" "node_memory_MemTotal_bytes" "node_filesystem_size_bytes")
        
        for metric in "${key_metrics[@]}"; do
            if echo "$metrics" | grep -q "^$metric"; then
                test_result "Node Exporter metric '$metric'" "PASS"
            else
                test_result "Node Exporter metric '$metric'" "FAIL" "Metric not found"
            fi
        done
    else
    test_result "Node Exporter metrics" "FAIL" "Failed to fetch metrics"
    fi
}

# Application integration checks
check_app_integration() {
    log "Checking integration with Books App..."
    
    # Check availability of application metrics directly
    if curl -s "http://localhost:5000/api/metrics" > /dev/null 2>&1; then
    test_result "Books App /api/metrics" "PASS"
        
    # Check specific application metrics
        if metrics=$(curl -s "http://localhost:5000/api/metrics" 2>/dev/null); then
            if echo "$metrics" | grep -q "http_request_duration_seconds"; then
                test_result "Books App HTTP metrics" "PASS"
            else
                test_result "Books App HTTP metrics" "FAIL" "HTTP metrics not found"
            fi
            
            if echo "$metrics" | grep -q "process_cpu_user_seconds_total"; then
                test_result "Books App process metrics" "PASS"
            else
                test_result "Books App process metrics" "FAIL" "Process metrics not found"
            fi
        fi
    else
    test_result "Books App /api/metrics" "FAIL" "Endpoint unreachable"
    warn "Ensure Books App is running on port 5000"
    fi
    
    # Check health endpoints
    if curl -s "http://localhost:5000/api/health/liveness" > /dev/null 2>&1; then
    test_result "Books App health liveness" "PASS"
    else
    test_result "Books App health liveness" "FAIL" "Liveness endpoint unreachable"
    fi
    
    if curl -s "http://localhost:5000/api/health/readiness" > /dev/null 2>&1; then
    test_result "Books App health readiness" "PASS"
    else
    test_result "Books App health readiness" "FAIL" "Readiness endpoint unreachable"
    fi
}

# Alert rule presence test
test_alert_system() {
    log "Testing alerting system..."
    
    # Verify alert rules loaded in Prometheus
    local prometheus_url="http://localhost:${PROMETHEUS_PORT:-9090}"
    
    if rules=$(curl -s "$prometheus_url/api/v1/rules" 2>/dev/null); then
        if echo "$rules" | jq -e '.data.groups[].rules[] | select(.name=="BooksAppDown")' > /dev/null 2>&1; then
            test_result "Alert rules loaded" "PASS"
        else
            test_result "Alert rules loaded" "FAIL" "BooksAppDown rule not found"
        fi
    else
    test_result "Prometheus API rules" "FAIL" "Failed to fetch rules"
    fi
}

# Performance checks
check_performance() {
    log "Checking monitoring system performance..."
    
    # Check response time of core services
    local services=("prometheus:${PROMETHEUS_PORT:-9090}/-/healthy" 
                   "grafana:${GRAFANA_PORT:-3000}/api/health" 
                   "alertmanager:${ALERTMANAGER_PORT:-9093}/-/healthy")
    
    for service in "${services[@]}"; do
        local name=${service%%:*}
        local endpoint="http://localhost:${service#*:}"
        
        local response_time=$(curl -s -w "%{time_total}" -o /dev/null "$endpoint" 2>/dev/null || echo "999")
        
        if (( $(echo "$response_time < 2" | bc -l 2>/dev/null || echo "0") )); then
            test_result "$name response time" "PASS" "${response_time}s"
        else
            test_result "$name response time" "FAIL" "${response_time}s (too slow)"
        fi
    done
}

# Final report
generate_report() {
    echo
    echo -e "${BLUE}╭─────────────────────────────────────────────────────────────╮${NC}"
    echo -e "${BLUE}│                    MONITORING TEST REPORT                   │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Total tests:      ${TOTAL_TESTS}                            │${NC}"
    echo -e "${BLUE}│ Passed:           ${PASSED_TESTS}                           │${NC}"
    echo -e "${BLUE}│ Failed:           ${FAILED_TESTS}                           │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    
    local success_rate=$((PASSED_TESTS * 100 / TOTAL_TESTS))
    if [[ $success_rate -ge 90 ]]; then
    echo -e "${BLUE}│ Result:   ${GREEN}EXCELLENT${NC} ${BLUE}(${success_rate}%)  │${NC}" 
    elif [[ $success_rate -ge 70 ]]; then
    echo -e "${BLUE}│ Result:   ${YELLOW}GOOD${NC} ${BLUE}(${success_rate}%)      │${NC}" 
    else
    echo -e "${BLUE}│ Result:   ${RED}ATTENTION REQUIRED${NC} ${BLUE}(${success_rate}%)│${NC}" 
    fi
    
    echo -e "${BLUE}╰─────────────────────────────────────────────────────────────╯${NC}"
    echo
    
    if [[ $FAILED_TESTS -gt 0 ]]; then
    echo -e "${YELLOW}Problem resolution recommendations:${NC}"
    echo "1. Check container logs: docker-compose -f docker-compose.monitoring.yml logs"
    echo "2. Ensure main app running: curl http://localhost:5000/api/metrics"
    echo "3. Review configuration files for errors"
    echo "4. Restart monitoring stack: ./scripts/setup_monitoring.sh"
        echo
        return 1
    else
    echo -e "${GREEN}Monitoring system operating normally!${NC}"
        echo
        return 0
    fi
}

# Main function
main() {
    echo -e "${BLUE}"
    echo "████████████████████████████████████████████████████"
    echo "█ Books App - Monitoring Test Suite              █"
    echo "█ Comprehensive monitoring system verification █"
    echo "████████████████████████████████████████████████████"
    echo -e "${NC}"
    
    # Load environment variables file if present
    if [[ -f ".env.monitoring" ]]; then
        export $(cat .env.monitoring | grep -v '^#' | xargs)
    fi
    
    # Dependency checks
    if ! command -v curl &> /dev/null; then
    error "curl not installed. Please install curl and retry."
    fi
    
    if ! command -v jq &> /dev/null; then
    warn "jq not installed. Some tests may be limited."
    fi
    
    # Run test suite
    check_prometheus_metrics
    check_grafana
    check_alertmanager
    check_node_exporter
    check_app_integration
    test_alert_system
    check_performance
    
    # Generate final report
    generate_report
}

# Execute script
main "$@"
