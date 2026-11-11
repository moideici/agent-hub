import { spawnSync } from 'node:child_process';

/** Mémoire de la carte NVIDIA (nvidia-smi). null si pas de carte NVIDIA ou si nvidia-smi ne répond pas. */
export function gpuInfoSync() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  if (r.error || r.status !== 0 || !r.stdout.trim()) return null;
  const [name, total, used, free] = r.stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
  if (![total, used, free].every((x) => Number.isFinite(+x))) return null;
  return { name, totalMiB: +total, usedMiB: +used, freeMiB: +free };
}

/**
 * Mémoire vidéo dédiée par processus (Windows : compteurs de performance). Sert à savoir QUI occupe la carte.
 * Renvoie [{ pid, name, mib }] triés du plus gros au plus petit ; [] hors Windows ou en cas d'échec.
 */
export function vramByProcess(minMiB = 20) {
  if (process.platform !== 'win32') return [];
  const script = `
$s = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples
$by = @{}
foreach ($x in $s) { if ($x.InstanceName -match 'pid_(\\d+)_') { $p = [int]$Matches[1]; $by[$p] = $by[$p] + $x.CookedValue } }
foreach ($p in $by.Keys) { $n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; "$p|$n|$([math]::Round($by[$p]/1MB))" }`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split('|'))
    .filter((p) => p.length === 3 && +p[2] >= minMiB)
    .map(([pid, name, mib]) => ({ pid: +pid, name: name || `pid ${pid}`, mib: +mib }))
    .sort((a, b) => b.mib - a.mib);
}
