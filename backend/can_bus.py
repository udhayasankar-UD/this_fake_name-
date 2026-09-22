"""CAN transport.

Telemetry does not arrive as a Python dict on a real aircraft, it arrives as CAN
frames that have to be decoded against a DBC. This module keeps that true even in
simulation: the ECU model encodes signals into real 8-byte frames, they go onto a
bus, and the twin decodes them back. Swapping the simulated bus for a real one is
a one-line change, and nothing downstream knows the difference.

Backends, in order of preference:
  socketcan  a real (or vcan) kernel interface, if one exists
  virtual    python-can's in-process bus - real frames, no kernel needed
"""

import os
import can
import cantools

DBC_PATH = os.path.join(os.path.dirname(__file__), 'dbc', 'engine.dbc')

# source address per engine, encoded into the low byte of the 29-bit id
SOURCE_ADDR = {'port': 0xFE, 'starboard': 0xFD}


def _sa(frame_id, addr):
    return (frame_id & 0xFFFFFF00) | (addr & 0xFF)


class EngineBus:
    def __init__(self, channel=None, prefer_socketcan=True):
        self.db = cantools.database.load_file(DBC_PATH)
        self.backend = None
        self.bus = None

        if prefer_socketcan and channel:
            try:
                self.bus = can.interface.Bus(channel=channel, interface='socketcan')
                self.backend = f'socketcan:{channel}'
            except Exception:
                self.bus = None

        if self.bus is None:
            self.bus = can.interface.Bus(channel='shadowtwin', interface='virtual',
                                         receive_own_messages=True)
            self.backend = 'virtual'

        self.msgs = {m.name: m for m in self.db.messages}

    # ------------------------------------------------------------- encode

    def publish(self, side: str, telemetry: dict):
        """Encode a telemetry snapshot into real CAN frames and send them."""
        addr = SOURCE_ADDR[side]
        frames = self._build_frames(telemetry)
        sent = 0
        for name, signals in frames.items():
            msg = self.msgs[name]
            try:
                data = msg.encode(signals, strict=False)
            except Exception:
                continue
            self.bus.send(can.Message(
                arbitration_id=_sa(msg.frame_id, addr),
                data=data, is_extended_id=True))
            sent += 1
        return sent

    def _build_frames(self, t):
        clamp = lambda v, lo, hi: max(lo, min(hi, v))
        return {
            'EEC1': {
                'EngineSpeed': clamp(t['rpm'], 0, 8031),
                'ActualEnginePercentTorque': clamp(t.get('torque_pct', 60), -125, 125),
                'DriversDemandPercentTorque': clamp(t.get('demand_pct', 60), -125, 125),
            },
            'ET1': {
                'EngineCoolantTemperature': clamp(t.get('coolant_c', t['cht_c'] * 0.55), -40, 210),
                'EngineFuelTemperature': clamp(t.get('fuel_temp_c', 38), -40, 210),
                'EngineOilTemperature': clamp(t['oil_temp_c'], -273, 1735),
                'EngineTurboOilTemperature': clamp(t.get('turbo_oil_c', t['oil_temp_c'] + 14), -273, 1735),
            },
            'EFL_P1': {
                'EngineFuelDeliveryPressure': clamp(t.get('fuel_press_kpa', 480), 0, 1000),
                'EngineOilLevel': clamp(t.get('oil_level_pct', 86), 0, 100),
                'EngineOilPressure': clamp(t['oil_press_bar'] * 100.0, 0, 1000),
                'EngineCoolantPressure': clamp(t.get('coolant_press_kpa', 120), 0, 500),
            },
            'IC1': {
                'EngineIntakeManifoldPressure': clamp(t['p_man_kpa'], 0, 500),
                'EngineIntakeManifoldTemperature': clamp(t['T_man_c'], -40, 210),
                'EngineExhaustGasTemperature': clamp(t['egt_c'], -273, 1735),
            },
            'LFE': {
                'EngineFuelRate': clamp(t['fuel_rate_lph'], 0, 3212),
                'EngineInstantaneousFuelEconomy': clamp(t.get('economy', 0.5), 0, 125),
            },
            'VIB1': {
                'EngineVibrationRMS': clamp(t['vibration_mms'], 0, 65),
                'EngineVibrationPeak': clamp(t['vibration_mms'] * 1.8, 0, 65),
                'CylinderHeadTemperature': clamp(t['cht_c'], -273, 1735),
            },
            'INJ1': {
                f'Injector{i}TimingActual': clamp(t.get(f'inj{i}_deg', -8.5), -200, 301)
                for i in (1, 2, 3, 4)
            },
            'RAIL1': {
                'CommonRailPressure': clamp(t['rail_bar'], 0, 6553),
                'AlternatorVoltage': clamp(t.get('alt_volts', 28.2), 0, 3212),
                'AlternatorCurrent': clamp(t.get('alt_amps', 42.0), -1600, 1612),
            },
        }

    # ------------------------------------------------------------- decode

    def drain(self, timeout=0.0):
        """Read whatever is on the bus and decode it into {side: {signal: value}}."""
        out = {'port': {}, 'starboard': {}}
        rev = {v: k for k, v in SOURCE_ADDR.items()}
        while True:
            m = self.bus.recv(timeout=timeout)
            if m is None:
                break
            addr = m.arbitration_id & 0xFF
            side = rev.get(addr)
            if side is None:
                continue
            base = _sa(m.arbitration_id, 0xFE)
            try:
                decoded = self.db.decode_message(base, m.data)
            except Exception:
                continue
            out[side].update(decoded)
        return out

    @staticmethod
    def to_telemetry(decoded: dict):
        """Map decoded CAN signals back to the names the twin works in."""
        if not decoded:
            return None
        g = decoded.get
        return {
            'rpm': g('EngineSpeed'),
            'cht_c': g('CylinderHeadTemperature'),
            'egt_c': g('EngineExhaustGasTemperature'),
            'oil_temp_c': g('EngineOilTemperature'),
            'oil_press_bar': (g('EngineOilPressure') or 0) / 100.0,
            'boost_bar': (g('EngineIntakeManifoldPressure') or 0) / 100.0,
            'p_man_kpa': g('EngineIntakeManifoldPressure'),
            'T_man_c': g('EngineIntakeManifoldTemperature'),
            'fuel_rate_lph': g('EngineFuelRate'),
            'vibration_mms': g('EngineVibrationRMS'),
            'rail_bar': g('CommonRailPressure'),
            'alt_volts': g('AlternatorVoltage'),
            'inj_timing': [g(f'Injector{i}TimingActual') for i in (1, 2, 3, 4)],
        }

    def shutdown(self):
        try:
            self.bus.shutdown()
        except Exception:
            pass
