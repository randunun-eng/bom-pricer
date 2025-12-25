#!/bin/bash
# Wrapper to run scrape_interactive.py with .env support

# Load .env if it exists
if [ -f .env ]; then
  # Use set -a to automatically export variables
  set -a
  source .env
  set +a
fi

# Check if API_KEY is set
if [ -z "$API_KEY" ]; then
  echo "❌ Error: API_KEY not found."
  echo "👉 Create a .env file with: API_KEY='your_key_here'"
  echo "   Or run: export API_KEY='...' before running this script."
  exit 1
fi

# Check valid command
if [ -z "$1" ]; then
  echo "Usage: ./scripts/run_interactive.sh \"KEYWORD\""
  exit 1
fi

# Activate venv if not active
if [[ "$VIRTUAL_ENV" == "" ]]; then
  if [ -f .venv/bin/activate ]; then
    source .venv/bin/activate
  else
    echo "⚠️ Warning: .venv not found. Python may fail if dependencies are missing."
  fi
fi

# Run the python script
exec python3 scripts/scrape_interactive.py "$@"
