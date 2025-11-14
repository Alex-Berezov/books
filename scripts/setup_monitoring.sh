#!/bin/bash

# Books App Monitoring Setup Script
# Monitoring system setup (Prometheus + Grafana + AlertManager)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging helpers
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[WARNING] $1${NC}"
}

error() {
    echo -e "${RED}[ERROR] $1${NC}"
    exit 1
}

# Dependency check
check_dependencies() {
    log "Checking dependencies..."
    
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Install Docker and try again."
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        if ! docker compose version &> /dev/null; then
            error "Docker Compose not found. Install Docker Compose and try again."
        fi
    fi
    
    log "✓ All dependencies are installed"
}

# Create Docker networks
create_networks() {
    log "Creating Docker networks..."
    
    # Check if books-network exists
    if ! docker network ls | grep -q "books-network"; then
        docker network create books-network
        log "✓ Created network books-network"
    else
        log "✓ Network books-network already exists"
    fi
}

# Configure files
setup_configs() {
    log "Configuring files..."
    
    # Check required files exist
    required_files=(
        "configs/prometheus.yml"
        "configs/alert_rules.yml"
        "configs/alertmanager.yml"
        "docker-compose.monitoring.yml"
    )
    
    for file in "${required_files[@]}"; do
        if [[ ! -f "$file" ]]; then
            error "File $file not found. Ensure all configuration files are present."
        fi
    done
    
    # Copy alert_rules.yml into Prometheus config dir
    cp configs/alert_rules.yml configs/prometheus_alert_rules.yml 2>/dev/null || true
    
    log "✓ Configuration files verified"
}

# Update Prometheus config for correct app access
update_prometheus_config() {
    log "Updating Prometheus configuration..."
    
    # Determine correct target for Docker environment
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS (Docker Desktop)
        TARGET="host.docker.internal:5000"
    elif [[ -f /.dockerenv ]] || grep -q docker /proc/1/cgroup 2>/dev/null; then
        # Inside a Docker container
        TARGET="172.17.0.1:5000"
    else
        # Linux host
        TARGET="172.17.0.1:5000"
    fi
    
    # Update target in Prometheus configuration
    if grep -q "host.docker.internal:5000" configs/prometheus.yml; then
        if [[ "$OSTYPE" != "darwin"* ]]; then
            sed -i "s/host.docker.internal:5000/$TARGET/g" configs/prometheus.yml
            log "✓ Updated target for Linux environment: $TARGET"
        fi
    fi
}

# Start monitoring
start_monitoring() {
    log "Starting monitoring stack..."
    
    # Stop existing containers (if any)
    docker-compose -f docker-compose.monitoring.yml down 2>/dev/null || true
    
    # Load env variables
    if [[ -f ".env.monitoring" ]]; then
        log "Loading environment variables from .env.monitoring"
        export $(cat .env.monitoring | grep -v '^#' | xargs)
    fi
    
    # Start services
    docker-compose -f docker-compose.monitoring.yml up -d
    
    log "✓ Monitoring system started"
}

# Wait for services to be ready
wait_for_services() {
    log "Waiting for services to become ready..."
    
    local services=("prometheus:9090" "grafana:3000" "node-exporter:9100" "alertmanager:9093")
    local max_attempts=30
    local attempt=0
    
    for service in "${services[@]}"; do
        local name=${service%:*}
        local port=${service#*:}
        
        attempt=0
        while [[ $attempt -lt $max_attempts ]]; do
            if docker-compose -f docker-compose.monitoring.yml exec -T $name wget -q --spider http://localhost:$port 2>/dev/null; then
                log "✓ $name is ready"
                break
            fi
            
            ((attempt++))
            if [[ $attempt -eq $max_attempts ]]; then
                warn "$name not ready after $max_attempts attempts"
            else
                sleep 2
            fi
        done
    done
}

# Test services availability
test_services() {
    log "Testing services availability..."
    
    local prometheus_port=${PROMETHEUS_PORT:-9090}
    local grafana_port=${GRAFANA_PORT:-3000}
    local alertmanager_port=${ALERTMANAGER_PORT:-9093}
    
    # Test Prometheus
    if curl -sf "http://localhost:$prometheus_port/-/healthy" > /dev/null; then
        log "✓ Prometheus available on port $prometheus_port"
    else
        error "Prometheus unavailable on port $prometheus_port"
    fi
    
    # Test Grafana
    if curl -sf "http://localhost:$grafana_port/api/health" > /dev/null; then
        log "✓ Grafana available on port $grafana_port"
    else
        error "Grafana unavailable on port $grafana_port"
    fi
    
    # Test AlertManager
    if curl -sf "http://localhost:$alertmanager_port/-/healthy" > /dev/null; then
        log "✓ AlertManager available on port $alertmanager_port"
    else
        error "AlertManager unavailable on port $alertmanager_port"
    fi
}

# Access information
show_access_info() {
    log "Monitoring system installed successfully!"
    echo
    echo -e "${BLUE}╭─────────────────────────────────────────────────────────────╮${NC}"
    echo -e "${BLUE}│                        SERVICE ACCESS                         │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Grafana:      http://localhost:${GRAFANA_PORT:-3000}                              │${NC}"
    echo -e "${BLUE}│ Prometheus:   http://localhost:${PROMETHEUS_PORT:-9090}                              │${NC}"
    echo -e "${BLUE}│ AlertManager: http://localhost:${ALERTMANAGER_PORT:-9093}                              │${NC}"
    echo -e "${BLUE}│ Node Exporter: http://localhost:${NODE_EXPORTER_PORT:-9100}                             │${NC}"
    echo -e "${BLUE}├─────────────────────────────────────────────────────────────┤${NC}"
    echo -e "${BLUE}│ Grafana login: ${GRAFANA_ADMIN_USER:-admin} / ${GRAFANA_ADMIN_PASSWORD:-admin123}                          │${NC}"
    echo -e "${BLUE}╰─────────────────────────────────────────────────────────────╯${NC}"
    echo
    echo -e "${GREEN}Grafana dashboards will be loaded automatically.${NC}"
    echo -e "${GREEN}To verify, run: ./scripts/test_monitoring.sh${NC}"
}

# Main function
main() {
    echo -e "${BLUE}"
    echo "████████████████████████████████████████████████████"
    echo "█ Books App - Monitoring Setup                    █"
    echo "█ Install Prometheus + Grafana + AlertManager     █"
    echo "████████████████████████████████████████████████████"
    echo -e "${NC}"
    
    check_dependencies
    create_networks
    setup_configs
    update_prometheus_config
    start_monitoring
    
    sleep 10  # Give services time to start
    
    wait_for_services
    test_services
    show_access_info
}

# Interrupt handling
trap 'error "Installation interrupted by user"' INT

# Run script
main "$@"
