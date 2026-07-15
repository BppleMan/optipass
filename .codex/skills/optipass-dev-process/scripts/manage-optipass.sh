#!/usr/bin/env bash

set -u

ROOT="${OPTIPASS_ROOT:-/Users/bppleman/RustroverProjects/optipass}"
API_DIR="$ROOT/apps/api"
API_PORT="3417"
WEB_PORT="4200"

usage() {
    echo "用法: $0 {status|stop}"
}

port_pids() {
    lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

pid_is_alive() {
    kill -0 "$1" 2>/dev/null
}

kill_tree() {
    local pid="$1"
    local child
    if ! pid_is_alive "$pid"; then
        return
    fi

    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
        kill_tree "$child"
    done
    kill -TERM "$pid" 2>/dev/null || true
}

wait_for_exit() {
    local pid="$1"
    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        if ! pid_is_alive "$pid"; then
            return
        fi
        sleep 0.2
    done
    kill -KILL "$pid" 2>/dev/null || true
}

stop_port_processes() {
    local port="$1"
    local pid
    for pid in $(port_pids "$port"); do
        kill_tree "$pid"
        wait_for_exit "$pid"
    done
}

stop_matching_processes() {
    stop_port_processes "$API_PORT"
    stop_port_processes "$WEB_PORT"

    local pid
    for pid in $(pgrep -f "$API_DIR/.+tsx.+watch src/server\\.ts" 2>/dev/null || true); do
        kill_tree "$pid"
        wait_for_exit "$pid"
    done
    for pid in $(pgrep -f "ng serve --host 127\\.0\\.0\\.1" 2>/dev/null || true); do
        kill_tree "$pid"
        wait_for_exit "$pid"
    done
}

port_ready() {
    local port="$1"
    curl --max-time 1 -sS -o /dev/null "http://127.0.0.1:$port/"
}

print_status() {
    local api_state="stopped"
    local web_state="stopped"
    if port_ready "$API_PORT"; then
        api_state="running"
    fi
    if port_ready "$WEB_PORT"; then
        web_state="running"
    fi
    printf 'api: %s (127.0.0.1:%s)\n' "$api_state" "$API_PORT"
    printf 'web: %s (127.0.0.1:%s)\n' "$web_state" "$WEB_PORT"
    [[ "$api_state" == "running" && "$web_state" == "running" ]]
}

stop_services() {
    stop_matching_processes
    if port_ready "$API_PORT" || port_ready "$WEB_PORT"; then
        echo "Optipass 停止失败：仍有端口占用。"
        return 1
    fi
    echo "Optipass 已停止，3417 和 4200 端口均已释放。"
}

case "${1:-}" in
    status)
        print_status
        ;;
    stop)
        stop_services
        ;;
    *)
        usage
        exit 2
        ;;
esac
