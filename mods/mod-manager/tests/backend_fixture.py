"""Test-only local Git transport. Production never accepts a local source path."""
import importlib.util
import json
from pathlib import Path
import sys

# Isolated Python omits the script directory from sys.path. Load this trusted fixture explicitly.
spec = importlib.util.spec_from_file_location("fixture_operations_tests", Path(__file__).with_name("test_operations.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.LocalOperations.source = Path(sys.argv[2])
request = json.loads(sys.argv[3])
request.update(runtimeKnown=True, dependencies=[])
print(json.dumps(module.LocalOperations(sys.argv[1]).run(request)))
