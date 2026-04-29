#!/bin/bash

echo "🚀 Starting NIM ↔ Claude Proxy..."

if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ ! -d "node_modules" ]; then
  npm install
fi

export ANTHROPIC_BASE_URL=http://localhost:${PORT:-3000}
export ANTHROPIC_API_KEY=sk-ant-test-key-do-not-use

node proxy.js
