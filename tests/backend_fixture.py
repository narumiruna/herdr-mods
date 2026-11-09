"""Test-only transport bridge. Production never accepts local repository paths."""
import json
import sys
from pathlib import Path

from test_operations import LocalOperations

LocalOperations.source = Path(sys.argv[2])
request = json.loads(sys.argv[3])
request.update(runtimeKnown=True, dependencies=[])
print(json.dumps(LocalOperations(sys.argv[1]).run(request)))
