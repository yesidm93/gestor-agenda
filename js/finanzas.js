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

export function resumenMes(movs, mes) {
  const delMes = movs.filter(m => mesDe(m.fecha) === mes);
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
  const cab = ['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Monto'];
  const filas = movs.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).map(m => [
    m.fecha, m.clase === 'gasto' ? 'Gasto' : 'Ingreso', m.categoria || '', (m.descripcion || '').replace(/[\r\n]+/g, ' '),
    String(m.clase === 'gasto' ? -m.monto : m.monto),
  ]);
  const esc = v => /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return '﻿' + [cab, ...filas].map(f => f.map(esc).join(';')).join('\r\n');
}
