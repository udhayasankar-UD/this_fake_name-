import os
import sys

# Add prototype/backend to sys.path and switch working directory
_here = os.path.dirname(os.path.abspath(__file__))
_backend = os.path.join(_here, 'prototype', 'backend')
if _backend not in sys.path:
    sys.path.insert(0, _backend)
os.chdir(_backend)

from server import app, station
import uvicorn

if __name__ == '__main__':
    print(f'CAN backend: {station.bus.backend}')
    print(f'detector trained: {station.det.trained}')
    port = int(os.environ.get('PORT', 8000))
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='warning')
