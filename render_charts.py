#!/usr/bin/env python3
"""
Chart renderer: OHLCV + Bollinger Bands (20,2) + entry/exit signals
Uses mplfinance for professional candlestick charts
"""
import json, sys, subprocess, os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import mplfinance as mpf

# ─── Colors ───────────────────────────────────────────────────────────────────
COLOR_UP    = '#26a69a'
COLOR_DOWN  = '#ef5350'
COLOR_UPPER = '#ff9800'
COLOR_MID   = '#2196f3'
COLOR_LOWER = '#ff9800'
COLOR_BUY   = '#00e676'
COLOR_SELL  = '#ff1744'
COLOR_BG    = '#131722'

# ─── Helpers ──────────────────────────────────────────────────────────────────

def compute_bb(closes, period=20, mult=2.0):
    closes = np.array(closes, dtype=float)
    n = len(closes)
    upper = np.full(n, np.nan)
    middle = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    bpct = np.full(n, np.nan)
    for i in range(period - 1, n):
        sl = closes[i - period + 1 : i + 1]
        ma = sl.mean()
        sd = sl.std(ddof=0)
        u, l = ma + mult * sd, ma - mult * sd
        upper[i] = u
        middle[i] = ma
        lower[i] = l
        bw = u - l
        bpct[i] = (closes[i] - l) / bw * 100 if bw > 0 else 50.0
    return upper, middle, lower, bpct


def detect_signals(df, upper, middle, lower, bpct):
    closes = df['Close'].values
    signals = []
    for i in range(1, len(closes)):
        if np.isnan(bpct[i]) or np.isnan(bpct[i-1]):
            continue
        bp, bp_prev = bpct[i], bpct[i-1]
        c, c_prev = closes[i], closes[i-1]
        # Efecto Imán abajo → compra
        if bp_prev < 0 and bp >= 0:
            signals.append((i, 'E6-Efecto Imán ↑', 'buy'))
        # Efecto Imán arriba → venta
        elif bp_prev > 100 and bp <= 100:
            signals.append((i, 'E5-Efecto Imán ↓', 'sell'))
        # Rebote inferior → compra
        elif bp < 15 and c > c_prev:
            signals.append((i, 'E3-Rebote Inferior', 'buy'))
        # Rebote superior → venta
        elif bp > 85 and c < c_prev:
            signals.append((i, 'E4-Rebote Superior', 'sell'))
        # Rebote .Medio alcista
        elif 42 < bp < 58 and bp_prev < 42 and c > middle[i]:
            signals.append((i, 'E2-.Medio ↑', 'buy'))
        # Rebote .Medio bajista
        elif 42 < bp < 58 and bp_prev > 58 and c < middle[i]:
            signals.append((i, 'E2-.Medio ↓', 'sell'))
    return signals[-4:] if len(signals) > 4 else signals


def fetch_ohlcv(symbol, resolution, countback=80):
    env = os.environ.copy()
    env['TV_SESSION_FILE'] = '/Users/oturajuani/.tradingview-session.json'
    r = subprocess.run(
        ['node', '/tmp/fetch_ohlcv.mjs', symbol, resolution, str(countback)],
        capture_output=True, text=True, env=env, timeout=35
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return json.loads(r.stdout)


def make_chart(bars_raw, title, output_path, resolution='1D'):
    if len(bars_raw) < 22:
        print(f"  [skip] not enough bars for {title}")
        return False

    df = pd.DataFrame(bars_raw)
    df['Date'] = (pd.to_datetime(df['time'], unit='s', utc=True)
                  .dt.tz_convert('America/New_York')
                  .dt.tz_localize(None))
    df = df.set_index('Date').rename(columns={
        'open': 'Open', 'high': 'High', 'low': 'Low',
        'close': 'Close', 'volume': 'Volume'
    })[['Open', 'High', 'Low', 'Close', 'Volume']].sort_index().iloc[-60:]

    closes = df['Close'].values
    upper, middle, lower, bpct = compute_bb(closes)

    idx = df.index
    upper_s  = pd.Series(upper,  index=idx)
    middle_s = pd.Series(middle, index=idx)
    lower_s  = pd.Series(lower,  index=idx)
    bpct_s   = pd.Series(bpct,   index=idx)

    signals = detect_signals(df, upper, middle, lower, bpct)

    buy_s  = pd.Series(np.nan, index=idx)
    sell_s = pd.Series(np.nan, index=idx)
    for i, name, direction in signals:
        if i < len(df):
            if direction == 'buy':
                buy_s.iloc[i]  = df['Low'].iloc[i]  * 0.985
            else:
                sell_s.iloc[i] = df['High'].iloc[i] * 1.015

    ap = [
        mpf.make_addplot(upper_s,  color=COLOR_UPPER, width=1.6, linestyle='--', alpha=0.85, panel=0),
        mpf.make_addplot(middle_s, color=COLOR_MID,   width=1.6, alpha=0.9,      panel=0),
        mpf.make_addplot(lower_s,  color=COLOR_LOWER, width=1.6, linestyle='--', alpha=0.85, panel=0),
        mpf.make_addplot(bpct_s,   color='#ab47bc',   width=1.3, panel=2, ylabel='B%'),
        mpf.make_addplot(pd.Series(0.0,   index=idx), color='#ef5350', width=0.7,
                         linestyle='dotted', alpha=0.6, panel=2),
        mpf.make_addplot(pd.Series(50.0,  index=idx), color='#2196f3', width=0.7,
                         linestyle='dotted', alpha=0.6, panel=2),
        mpf.make_addplot(pd.Series(100.0, index=idx), color='#26a69a', width=0.7,
                         linestyle='dotted', alpha=0.6, panel=2),
    ]
    if buy_s.notna().any():
        ap.append(mpf.make_addplot(buy_s,  type='scatter', markersize=110, marker='^',
                                   color=COLOR_BUY, panel=0))
    if sell_s.notna().any():
        ap.append(mpf.make_addplot(sell_s, type='scatter', markersize=110, marker='v',
                                   color=COLOR_SELL, panel=0))

    mc = mpf.make_marketcolors(
        up=COLOR_UP, down=COLOR_DOWN,
        edge={'up': COLOR_UP, 'down': COLOR_DOWN},
        wick={'up': COLOR_UP, 'down': COLOR_DOWN},
        volume={'up': COLOR_UP, 'down': COLOR_DOWN},
    )
    s = mpf.make_mpf_style(
        marketcolors=mc,
        facecolor=COLOR_BG, edgecolor='#2a2e39', figcolor=COLOR_BG,
        gridcolor='#2a2e39', gridstyle='-', gridaxis='both',
        y_on_right=True,
        rc={
            'font.size': 9, 'text.color': '#d1d4dc',
            'axes.labelcolor': '#d1d4dc',
            'xtick.color': '#787b86', 'ytick.color': '#787b86',
        }
    )

    last_close = closes[-1]
    last_bp    = bpct[-1]
    pct_change = (last_close - closes[-2]) / closes[-2] * 100

    if np.isnan(last_bp):    setup_str = 'Sin datos'
    elif last_bp > 100:      setup_str = f'E5-Efecto Imán ↓ SELL | B%={last_bp:.0f}%'
    elif last_bp < 0:        setup_str = f'E6-Efecto Imán ↑ BUY  | B%={last_bp:.0f}%'
    elif last_bp < 20:       setup_str = f'E3-Rebote Inferior BUY | B%={last_bp:.0f}%'
    elif last_bp > 80:       setup_str = f'E4-Rebote Superior SELL| B%={last_bp:.0f}%'
    elif 40 < last_bp < 60:  setup_str = f'E2-Rebote .Medio | B%={last_bp:.0f}%'
    else:                    setup_str = f'En rango | B%={last_bp:.0f}%'

    chart_title = (
        f"{title}  [{resolution}]  "
        f"${last_close:.2f} ({pct_change:+.2f}%)\n"
        f"BB: {upper[-1]:.2f} / {middle[-1]:.2f} / {lower[-1]:.2f}   "
        f"Setup: {setup_str}"
    )

    fig, axes = mpf.plot(
        df, type='candle', style=s, addplot=ap, volume=True,
        figsize=(14, 9), title=chart_title,
        panel_ratios=(5, 1.5, 2), returnfig=True,
    )

    ax_price = axes[0]
    ax_vol   = axes[2]
    ax_bpct  = axes[4]

    # BB fill between upper/lower
    valid = ~(np.isnan(upper) | np.isnan(lower))
    xi = np.where(valid)[0]
    if len(xi):
        ax_price.fill_between(xi, upper[valid], lower[valid],
                              alpha=0.06, color='#ff9800', zorder=0)

    # Current price dashed line
    ax_price.axhline(y=last_close, color='#ffffffaa', linewidth=0.7, linestyle=':')

    # Signal labels
    for i, name, direction in signals:
        if i < len(df):
            yval = df['Low'].iloc[i] if direction == 'buy' else df['High'].iloc[i]
            offset = yval * (0.97 if direction == 'buy' else 1.03)
            color = COLOR_BUY if direction == 'buy' else COLOR_SELL
            va = 'top' if direction == 'sell' else 'bottom'
            ax_price.annotate(name, xy=(i, yval), xytext=(i, offset),
                fontsize=7, color=color, ha='center', va=va, fontweight='bold',
                bbox=dict(boxstyle='round,pad=0.2', fc=COLOR_BG, alpha=0.8, ec=color))

    # B% reference labels
    for val, label, col in [(0, '0', '#ef5350'), (50, '50', '#2196f3'), (100, '100', '#26a69a')]:
        ax_bpct.text(0.01, val, label, transform=ax_bpct.get_yaxis_transform(),
                     fontsize=7, color=col, va='center', alpha=0.8)

    # Legend
    legend_items = [
        mpatches.Patch(color=COLOR_UPPER, label=f'BB Superior  {upper[-1]:.2f}'),
        mpatches.Patch(color=COLOR_MID,   label=f'.Medio MA20  {middle[-1]:.2f}'),
        mpatches.Patch(color=COLOR_LOWER, label=f'BB Inferior  {lower[-1]:.2f}'),
        mpatches.Patch(color=COLOR_BUY,   label='Entrada LONG ▲'),
        mpatches.Patch(color=COLOR_SELL,  label='Salida / SELL ▼'),
    ]
    ax_price.legend(handles=legend_items, loc='upper left', fontsize=8,
                    facecolor='#1e2230', edgecolor='#2a2e39', labelcolor='#d1d4dc')

    fig.savefig(output_path, dpi=140, bbox_inches='tight',
                facecolor=COLOR_BG, edgecolor='none')
    plt.close(fig)
    print(f"  [ok] {output_path}")
    return True


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("\n═══════════════════════════════════════")
    print("  ANÁLISIS BOLLINGER — 2026-05-19")
    print("═══════════════════════════════════════\n")

    charts = []

    jobs = [
        ('SP:SPX',      '60', 'SPX',  '/tmp/CHART_SPX_1H.png',   '1H'),
        ('SP:SPX',      '1D', 'SPX',  '/tmp/CHART_SPX_D.png',    'Daily'),
        ('NASDAQ:PURR', '1D', 'PURR', '/tmp/CHART_PURR_D.png',   'Daily'),
        ('NASDAQ:LPTH', '1D', 'LPTH', '/tmp/CHART_LPTH_D.png',   'Daily'),
        ('NASDAQ:CLSK', '1D', 'CLSK', '/tmp/CHART_CLSK_D.png',   'Daily'),
        ('NASDAQ:GO',   '1D', 'GO',   '/tmp/CHART_GO_D.png',     'Daily'),
    ]

    for sym, res, name, out, label in jobs:
        print(f"→ {name} [{label}]...")
        try:
            bars = fetch_ohlcv(sym, res, 80)
            ok = make_chart(bars, name, out, resolution=label)
            if ok:
                charts.append((name, label, out))
        except Exception as e:
            print(f"  [err] {e}")

    print(f"\n✓ {len(charts)} charts saved")
    for name, res, path in charts:
        print(f"  {name} {res}: {path}")

    print("""
╔══════════════════════════════════════════════════════════════╗
║  RESUMEN — ACTIVOS PARA MAÑANA  |  2026-05-19               ║
╠══════════════════════════════════════════════════════════════╣
║  SPX OPTIONS (CALL) — Setup E3-Rebote Inferior               ║
║  Precio: 7,353 | B% 1H = 21% → Zona lower BB                 ║
║  Entrada: rebote en 7,327-7,353                               ║
║  Target 1: 7,390 (.Medio)  → +80-120% en opción              ║
║  Target 2: 7,453 (Upper BB) → +200-300% en opción            ║
║  Stop: cierre 1H < 7,300                                      ║
╠══════════════════════════════════════════════════════════════╣
║  ACCIONES $5-$25 — MOMENTUM                                   ║
║  PURR  $7.79  +12.4%  B%=118% → ESPERAR pull-back a $6.47   ║
║  LPTH  $13.88 +11.6%  B%=70%  → Monitorear $10.62 (lower)   ║
║  CLSK  $14.69 +9.3%   B%=92%  → Cerca upper, cautela        ║
║  GO    $8.12  +7.0%   B%=77%  → Tendencia, esperar zona      ║
╠══════════════════════════════════════════════════════════════╣
║  REGLA PRICE ACTION PRO:                                      ║
║  "Si no hay setup, no hay trade"                              ║
║  Esperar que el precio LLEGUE a la zona de alta probabilidad  ║
╚══════════════════════════════════════════════════════════════╝
""")

if __name__ == '__main__':
    main()
