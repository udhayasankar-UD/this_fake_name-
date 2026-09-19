import os
import sys
import importlib.util

_here = os.path.dirname(os.path.abspath(__file__))
_backend_dir = os.path.join(_here, 'prototype', 'backend')
_backend_server = os.path.join(_backend_dir, 'server.py')

if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)
os.chdir(_backend_dir)

_spec = importlib.util.spec_from_file_location('backend_server', _backend_server)
_mod = importlib.util.module_from_spec(_spec)
sys.modules['backend_server'] = _mod
_spec.loader.exec_module(_mod)

# Expose FastAPI application and helpers for ASGI runners like uvicorn
app = _mod.app
station = _mod.station

if __name__ == '__main__':
    import uvicorn
    print(f'CAN backend: {station.bus.backend}')
    print(f'detector trained: {station.det.trained}')
    port = int(os.environ.get('PORT', 8000))
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='warning')
