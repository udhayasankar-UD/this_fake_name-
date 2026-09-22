"""Mean value engine model for a 4-cylinder turbocharged common-rail aero-diesel.

Reference class: 2.2 L inline-4, CRDi, wastegated turbo, reduction gearbox to a
propeller. Numbers are representative of that engine class, not measured from any
specific production unit.

The model is a mean-value formulation: quantities are averaged over a cycle rather
than resolved by crank angle. That is the standard compromise for a real-time digital
twin - fast enough to run in lockstep with live telemetry, while still being an
actual thermodynamic model rather than a curve fit.

States integrated over time:
    p_man   intake manifold (boost) pressure   [kPa]
    T_cht   cylinder head metal temperature    [degC]
    T_egt   exhaust gas temperature            [degC]
    T_oil   oil temperature                    [degC]

Everything else is algebraic from those states plus the operating point.
"""

from dataclasses import dataclass, field
import math

# ---------------------------------------------------------------- constants

R_AIR = 287.05          # J/(kg K)
CP_EXH = 1150.0         # J/(kg K), exhaust gas
LHV_DIESEL = 42.8e6     # J/kg
RHO_FUEL = 832.0        # kg/m3

# ISA sea level
P0 = 101.325            # kPa
T0 = 288.15             # K
LAPSE = 0.0065          # K/m
G = 9.80665
R_SPEC = 287.05


def isa(altitude_m: float):
    """ISA troposphere. Returns (pressure kPa, temperature K, density kg/m3)."""
    alt = max(0.0, min(altitude_m, 11000.0))
    T = T0 - LAPSE * alt
    p = P0 * (T / T0) ** (G / (LAPSE * R_SPEC))
    rho = p * 1000.0 / (R_SPEC * T)
    return p, T, rho


@dataclass
class EngineSpec:
    displacement_l: float = 2.2
    cylinders: int = 4
    strokes: int = 4
    max_power_kw: float = 134.0        # ~180 hp
    rated_rpm: float = 2700.0
    idle_rpm: float = 900.0
    compression_ratio: float = 16.5

    # volumetric efficiency curve (quadratic in normalised speed)
    eta_vol_peak: float = 0.95
    eta_vol_speed_peak: float = 0.62   # fraction of rated rpm

    # turbo
    boost_max_kpa: float = 320.0       # absolute manifold pressure at full boost
    wastegate_kpa: float = 325.0
    turbo_lag_s: float = 0.65

    # smoke limiter: FADEC trims fuel to hold a minimum air/fuel ratio
    lambda_min: float = 1.28

    # indicated efficiency
    eta_ind_peak: float = 0.42

    # friction, Chen-Flynn style fmep [kPa]
    fmep_a: float = 42.0
    fmep_b: float = 0.0055
    fmep_c: float = 0.00018

    # thermal
    head_mass_kg: float = 11.5
    head_cp: float = 896.0             # aluminium J/(kg K)
    head_hA_base: float = 245.0        # W/K at reference cooling airflow
    oil_mass_kg: float = 5.4
    oil_cp: float = 1980.0
    oil_hA: float = 65.0

    # oil pressure model
    oil_press_ref_bar: float = 4.2
    oil_press_ref_rpm: float = 2600.0
    oil_visc_ref_c: float = 92.0


@dataclass
class Health:
    """Degradation multipliers. 1.0 = as-new. These are what the twin is blind to
    and the detector has to infer from residuals."""
    injector_flow: list = field(default_factory=lambda: [1.0, 1.0, 1.0, 1.0])
    cooling_effectiveness: float = 1.0
    oil_pump_effectiveness: float = 1.0
    turbo_efficiency: float = 1.0
    ring_seal: float = 1.0             # affects volumetric efficiency
    bearing_wear: float = 0.0          # adds vibration


@dataclass
class State:
    p_man: float = 101.0
    T_cht: float = 60.0
    T_egt: float = 200.0
    T_oil: float = 40.0
    rpm: float = 900.0


class MeanValueEngineModel:
    def __init__(self, spec: EngineSpec = None):
        self.spec = spec or EngineSpec()
        self.state = State()

    # ---------------------------------------------------------- submodels

    def eta_vol(self, rpm: float, ring_seal: float = 1.0) -> float:
        s = self.spec
        x = rpm / s.rated_rpm
        xp = s.eta_vol_speed_peak
        # inverted parabola through the peak, clipped
        eta = s.eta_vol_peak * (1.0 - 1.15 * (x - xp) ** 2)
        eta = max(0.35, min(s.eta_vol_peak, eta))
        return eta * ring_seal

    def air_mass_flow(self, rpm, p_man, T_man_k, ring_seal=1.0):
        """kg/s drawn into the cylinders."""
        s = self.spec
        rho_man = (p_man * 1000.0) / (R_AIR * T_man_k)
        vd = s.displacement_l / 1000.0
        # 4-stroke: one intake event per two revolutions
        return self.eta_vol(rpm, ring_seal) * vd * (rpm / 60.0) / 2.0 * rho_man

    def fuel_mass_flow(self, throttle, rpm, health: Health):
        """kg/s. Throttle 0..1 maps to injected quantity per cycle."""
        s = self.spec
        # quantity per injection at full demand, m3
        q_max = 105e-9 * (1.0 + 0.10 * (1.0 - rpm / s.rated_rpm))
        q = q_max * max(0.0, min(1.0, throttle))
        per_cyl = [q * f for f in health.injector_flow]
        events_per_s = (rpm / 60.0) / 2.0
        vol_per_s = sum(per_cyl) * events_per_s
        return vol_per_s * RHO_FUEL

    def target_boost(self, throttle, rpm, p_amb, turbo_eff):
        s = self.spec
        demand = max(0.0, min(1.0, throttle))
        spool = min(1.0, (rpm / s.rated_rpm) / 0.55)
        raw = p_amb + (s.boost_max_kpa - P0) * demand * spool * turbo_eff
        return min(raw, s.wastegate_kpa)

    def fmep(self, rpm, p_man):
        s = self.spec
        return s.fmep_a + s.fmep_b * p_man * (rpm / 1000.0) + s.fmep_c * rpm ** 2 / 1000.0

    def indicated_efficiency(self, lam, rpm):
        """Falls off when mixture is very lean or very rich."""
        s = self.spec
        best = 1.9
        pen = 1.0 - 0.16 * abs(lam - best)
        pen = max(0.55, min(1.0, pen))
        spd = 1.0 - 0.22 * abs(rpm / s.rated_rpm - 0.75)
        return s.eta_ind_peak * pen * max(0.7, spd)

    # ---------------------------------------------------------- step

    def step(self, dt, throttle, altitude_m, oat_c, health: Health = None,
             rpm_command=None):
        s = self.spec
        h = health or Health()
        st = self.state

        p_amb, T_amb_k, rho_amb = isa(altitude_m)
        # allow a hot/cold day offset relative to ISA
        T_amb_k = T_amb_k + (oat_c - (T_amb_k - 273.15))
        T_amb_c = T_amb_k - 273.15

        # --- speed: governed propeller, first-order toward commanded rpm
        target_rpm = rpm_command if rpm_command is not None else (
            s.idle_rpm + (s.rated_rpm - s.idle_rpm) * max(0.0, min(1.0, throttle))
        )
        st.rpm += (target_rpm - st.rpm) * min(1.0, dt / 1.1)
        rpm = max(s.idle_rpm * 0.6, st.rpm)

        # --- boost: first-order lag toward the compressor target
        p_target = self.target_boost(throttle, rpm, p_amb, h.turbo_efficiency)
        st.p_man += (p_target - st.p_man) * min(1.0, dt / s.turbo_lag_s)
        p_man = st.p_man

        # --- intake charge temperature after compression + intercooler
        pr = max(1.0, p_man / p_amb)
        T_comp_k = T_amb_k * pr ** (0.2857 / max(0.55, 0.72 * h.turbo_efficiency))
        intercooler_eff = 0.68
        T_man_k = T_comp_k - intercooler_eff * (T_comp_k - T_amb_k)

        # --- flows
        m_air = self.air_mass_flow(rpm, p_man, T_man_k, h.ring_seal)
        m_fuel_demand = self.fuel_mass_flow(throttle, rpm, h)
        # smoke limiter: the ECU will not inject more than the trapped air can burn.
        # This is what stops a turbodiesel running rich and cooking the turbine as
        # air density falls with altitude.
        m_fuel_cap = m_air / (14.5 * s.lambda_min)
        m_fuel = min(m_fuel_demand, m_fuel_cap)
        fuel_limited = m_fuel_demand > m_fuel_cap * 1.001
        afr = m_air / max(1e-9, m_fuel)
        lam = afr / 14.5

        # --- power and torque
        eta_i = self.indicated_efficiency(lam, rpm)
        p_ind = m_fuel * LHV_DIESEL * eta_i                      # W
        vd = s.displacement_l / 1000.0
        p_fric = self.fmep(rpm, p_man) * 1000.0 * vd * (rpm / 60.0) / 2.0
        p_brake = max(0.0, p_ind - p_fric)
        omega = 2 * math.pi * rpm / 60.0
        torque = p_brake / max(1.0, omega)

        # --- exhaust temperature (energy left after work + heat to coolant)
        m_exh = m_air + m_fuel
        q_exh = m_fuel * LHV_DIESEL * (1.0 - eta_i) * 0.52
        T_egt_target = T_man_k + q_exh / max(1e-6, m_exh * CP_EXH)
        T_egt_target = min(T_egt_target, 1250.0 + 273.15)
        st.T_egt += (T_egt_target - 273.15 - st.T_egt) * min(1.0, dt / 1.8)

        # --- cylinder head metal temperature (lumped capacity)
        q_to_head = m_fuel * LHV_DIESEL * (1.0 - eta_i) * 0.30
        cooling_flow = 0.55 + 0.45 * min(1.0, rpm / s.rated_rpm)
        hA = s.head_hA_base * cooling_flow * h.cooling_effectiveness
        q_out = hA * (st.T_cht - T_amb_c)
        dT = (q_to_head - q_out) / (s.head_mass_kg * s.head_cp)
        st.T_cht += dT * dt

        # --- oil temperature
        q_to_oil = p_fric * 0.62 + q_to_head * 0.10
        q_oil_out = s.oil_hA * (st.T_oil - T_amb_c) * (0.6 + 0.4 * cooling_flow)
        st.T_oil += (q_to_oil - q_oil_out) / (s.oil_mass_kg * s.oil_cp) * dt

        # --- oil pressure: pump speed vs viscosity vs clearance
        visc = math.exp(-0.026 * (st.T_oil - s.oil_visc_ref_c))
        oil_press = (s.oil_press_ref_bar
                     * (rpm / s.oil_press_ref_rpm) ** 0.62
                     * visc ** 0.55
                     * h.oil_pump_effectiveness)
        oil_press = max(0.4, oil_press)

        # --- rail pressure follows demand
        rail = 420.0 + 900.0 * max(0.0, min(1.0, throttle)) * (0.55 + 0.45 * rpm / s.rated_rpm)

        # --- vibration: baseline + imbalance from injector spread + bearing wear
        spread = max(h.injector_flow) - min(h.injector_flow)
        vib = (0.85
               + 0.55 * (rpm / s.rated_rpm)
               + 6.2 * spread
               + 3.1 * h.bearing_wear)

        return {
            'rpm': rpm,
            'torque_nm': torque,
            'power_kw': p_brake / 1000.0,
            'p_man_kpa': p_man,
            'boost_bar': p_man / 100.0,
            'T_man_c': T_man_k - 273.15,
            'cht_c': st.T_cht,
            'egt_c': st.T_egt,
            'oil_temp_c': st.T_oil,
            'oil_press_bar': oil_press,
            'fuel_rate_lph': m_fuel / RHO_FUEL * 3600.0 * 1000.0,
            'air_flow_kgs': m_air,
            'lambda': lam,
            'rail_bar': rail,
            'vibration_mms': vib,
            'eta_ind': eta_i,
            'fuel_limited': fuel_limited,
            'amb_temp_c': T_amb_c,
            'amb_press_kpa': p_amb,
        }

    def reset(self, warm=True):
        self.state = State()
        if warm:
            self.state.T_cht = 175.0
            self.state.T_oil = 90.0
            self.state.T_egt = 600.0
            self.state.p_man = 130.0
            self.state.rpm = 2500.0
