#!/bin/sh
# husky
# v9 shim for POSIX sh

# this file is included by hooks and ensures POSIX sh compatibility

command_exists () {
  command -v "$1" >/dev/null 2>&1
}

# Yarn classic detection (optional)
if command_exists yarn; then
  :
fi
