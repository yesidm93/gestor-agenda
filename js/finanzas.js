// Finanzas: formato de dinero, categorías y cálculos

import { addDays, hoy, parseYmd } from './util.js';

export const CATEGORIAS_GASTO = [
  'Vivienda', 'Servicios', 'Celular e internet', 'Alimentación', 'Transporte', 'Educación',
  'Salud', 'Deudas', 'Ropa y cuidado', 'Entretenimiento', 'Familia', 'Ahorro', 'Otros',
];
export const CATEGORIAS_INGRESO = ['Salario', 'Honorarios docencia', 'Cobro de deuda', 'Ventas', 'Préstamo recibido', 'Otros ingresos'];

const fmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const fmtNum = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

export const pesos = n => fmt.format(Math.round(Number(n) || 0)).replace(/ /g, ' ');
export const numero = n => fmtNum.format(Math.round(Number(n) || 0));
/** "45.000", "$ 45.000", "45000,5" → 45000 */
export const leerMonto = s => Math.round(Number(String(s ?? '').replace(/[^\d,]/g, '').replace(',', '.')) || 0);

export const mesDe = ymd => ymd.slice(0, 7);
export const mesActual = () => hoy().slice(0, 7);
export function moverMes(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function nombreMes(mes) {
  const [y, m] = mes.split('-').map(Number);
  const t = new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1)).replace(' de ', ' ');
  return t[0].toUpperCase() + t.slice(1);
}

/** Solo gastos e ingresos (excluye el registro de saldo inicial) */
export const reales = movs => movs.filter(m => m.clase === 'gasto' || m.clase === 'ingreso');

export function resumenMes(movs, mes) {
  const delMes = reales(movs).filter(m => mesDe(m.fecha) === mes);
  const ingresos = delMes.filter(m => m.clase === 'ingreso').reduce((s, m) => s + m.monto, 0);
  const gastos = delMes.filter(m => m.clase === 'gasto').reduce((s, m) => s + m.monto, 0);
  const porCategoria = new Map();
  for (const m of delMes.filter(m => m.clase === 'gasto')) porCategoria.set(m.categoria || 'Otros', (porCategoria.get(m.categoria || 'Otros') || 0) + m.monto);
  const categorias = [...porCategoria].sort((a, b) => b[1] - a[1]);
  return { delMes, ingresos, gastos, balance: ingresos - gastos, categorias };
}

// ---------------- Deudas ----------------
export const abonado = d => (d.abonos || []).reduce((s, a) => s + (Number(a.monto) || 0), 0);
export const saldo = d => Math.max(0, (Number(d.monto) || 0) - abonado(d));
export const saldada = d => saldo(d) === 0;
export const deudaVencida = d => !saldada(d) && d.vence && d.vence < hoy();
export const venceProntoDeuda = d => !saldada(d) && d.vence && d.vence >= hoy() && d.vence <= addDays(hoy(), 7);

export function diasHasta(ymd) {
  return Math.round((parseYmd(ymd) - parseYmd(hoy())) / 86400000);
}

/** CSV para Excel (separador ; y BOM para que abra bien las tildes) */
export function movimientosCSV(movs) {
  movs = reales(movs);
  const cab = ['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Monto'];
  const filas = movs.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).map(m => [
    m.fecha, m.clase === 'gasto' ? 'Gasto' : 'Ingreso', m.categoria || '', (m.descripcion || '').replace(/[\r\n]+/g, ' '),
    String(m.clase === 'gasto' ? -m.monto : m.monto),
  ]);
  const esc = v => /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return '﻿' + [cab, ...filas].map(f => f.map(esc).join(';')).join('\r\n');
}

// ---------------- Saldo inicial y disponible ----------------
/** El saldo inicial es un movimiento especial (clase "base"); vale el más reciente */
export function saldoBase(movs) {
  return movs.filter(m => m.clase === 'base').sort((a, b) => b.fecha.localeCompare(a.fecha) || (b.creadoEn || 0) - (a.creadoEn || 0))[0] || null;
}

const ultimoDiaMes = mes => { const [y, m] = mes.split('-').map(Number); return `${mes}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

/**
 * Dinero disponible al final del mes (o hoy, si es el mes actual):
 * saldo inicial + ingresos − gastos registrados después de fijarlo.
 * Devuelve null si el mes es anterior al saldo inicial o no hay saldo inicial.
 */
export function disponible(movs, mes) {
  const base = saldoBase(movs);
  if (!base) return null;
  const hasta = mes === mesActual() ? hoy() : ultimoDiaMes(mes);
  if (hasta < base.fecha) return null;
  let total = Number(base.monto) || 0;
  for (const m of reales(movs)) {
    const despues = m.fecha > base.fecha || (m.fecha === base.fecha && (m.creadoEn || 0) > (base.creadoEn || 0));
    if (!despues || m.fecha > hasta) continue;
    total += m.clase === 'ingreso' ? m.monto : -m.monto;
  }
  return total;
}

// ---------------- Ahorros ----------------
export const totalAhorros = ahorros => ahorros.reduce((s, a) => s + (Number(a.monto) || 0), 0);
export const avanceMeta = a => (a.meta ? Math.min(100, Math.round(((Number(a.monto) || 0) / a.meta) * 100)) : null);
