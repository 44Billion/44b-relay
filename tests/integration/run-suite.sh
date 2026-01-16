#!/bin/bash
# Integration test suite runner
# https://github.com/mikedilger/relay-tester

# Check if tester binary exists
TESTER_BIN="./tests/integration/relay-tester/target/release/relay-tester"
if [ ! -f "$TESTER_BIN" ]; then
    echo "Error: relay-tester binary not found at $TESTER_BIN"
    echo "Please build it first or check the installation steps."
    exit 1
fi

# Generated keys
KEY_A="nsec1hqs3elsxe9vztcxjpnkeqr93y6ujw5agxazqwk90afg05wtq2r9q0a04mq"
KEY_B="nsec16hhgs8g77gtjxulnjx2jphfff6xxq3fhf6kk86zjd6c68clx0hmqx8ujs9"

# Config for the relay
export NODE_ENV=test
export PORT=8081
export RELAY_HOST=localhost:8081
export SHOULD_SPIN_UP_SERVER=true
export IS_INTEGRATION_TEST=true
# Ensure we have a database host (assuming a local or containerized one is intended)
# If the user has a local meilisearch running, they should set MDB_HOST.
# For this script, we assume the environment is set up similarly to unit tests.

echo "Starting relay on port $PORT..."
node index.js &
RELAY_PID=$!

# Trap to kill the relay if the script is interrupted or finishes
trap "kill $RELAY_PID" EXIT

# Wait for relay to be ready
echo "Waiting for relay to initialize..."
sleep 5

echo "Running relay-tester..."
$TESTER_BIN ws://localhost:$PORT "$KEY_A" "$KEY_B"

# Exit code of the tester will be the exit code of this script
exit $?
