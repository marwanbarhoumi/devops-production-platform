#!/bin/sh
# Validates the agent secret file, then hands over to the image's own entrypoint (jenkins-agent).
#
# The secret reaches agent.jar as "-secret @<file>": Remoting's argument parser replaces "@<file>"
# with the file's lines, so the secret never appears in the environment or the process list. An empty
# or malformed file would silently shift the remaining arguments ("-secret -name ..."), and agent.jar
# would print its usage text and exit. Fail early with an actionable message instead.
set -eu

secret_file="${JENKINS_SECRET_FILE:-/run/secrets/jenkins_agent_secret}"

fail() {
    echo "ERROR: $*" >&2
    echo "Fix: run jenkins/save-agent-secret.ps1, or copy the secret of node '${JENKINS_AGENT_NAME:-?}' from" >&2
    echo "Manage Jenkins > Nodes into jenkins/secrets/agent-secret, then: docker compose up -d agent" >&2
    echo "(see jenkins/README.md, section 4)." >&2
    exit 1
}

[ -f "$secret_file" ] || fail "agent secret file $secret_file does not exist."
[ -s "$secret_file" ] || fail "agent secret file is empty."
# Exactly the 64 hexadecimal characters Jenkins shows; a trailing newline (LF or CRLF) is tolerated.
if ! tr -d '\r\n' < "$secret_file" | grep -Eqx '[0-9a-f]{64}'; then
    fail "agent secret file is malformed: it must contain only the 64-character hexadecimal secret (no quotes, '-secret' prefix, spaces or UTF-16/BOM encoding)."
fi

export JENKINS_SECRET="@${secret_file}"
exec /usr/local/bin/jenkins-agent "$@"
