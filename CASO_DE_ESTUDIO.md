# Caso de estudio: Bodega Giselle

> Una página. Complete lo que está entre `[corchetes]` con datos reales. Quite lo que no pueda respaldar con hechos.

## El problema
Una abarrotería grande llevaba todo a cálculo: sin libros contables, sin saber qué productos estaban vencidos ni cuánto tenía en existencia. Los productos a granel (frijol, arroz, azúcar) no tienen código de barras. Datos de partida: `[productos aproximados, ventas diarias, cuántas personas atienden]`.

## Mi rol
`[Diseñé, desarrollé, probé, desplegué y capacité al personal. Describa lo que hizo usted, incluido el uso de IA como herramienta.]`

## La solución
Un sistema web local, con Python, SQLite y JavaScript, que corre en Windows o Linux sin internet:
- Inventario por lotes con vencimiento y venta por orden de vencimiento (FEFO).
- Caja con pistola lectora, productos por peso y fiados.
- Reportes de ventas, costos, ganancia y mercadería sin movimiento.
- Respaldos automáticos y mantenimiento remoto (Tailscale + SSH).

## Decisiones importantes
1. **SQLite en vez de PostgreSQL:** `[por qué, qué se sacrificó]`
2. **Stock calculado desde lotes:** `[problema que evita]`
3. **Productos sin código:** `[etiquetas EAN-13 internas o búsqueda por nombre]`
4. **Seguridad:** `[2-3 medidas que implementó y por qué]`

## Dificultades y cómo las resolví
- `[Ejemplo: al cambiar de pantalla rápido, una respuesta lenta pisaba la nueva → serialicé la navegación.]`
- `[Ejemplo: el reparto de redondeo al vender desde varios lotes → el último renglón toma el resto.]`
- `[Su propio ejemplo con el problema, la causa y la solución.]`

## Resultados
Complete solo con lo que haya medido:
- Tiempo por cobro: `[antes → después]`
- Productos vencidos detectados antes de venderse: `[cantidad]`
- Inventario valorizado por primera vez: `[monto]`
- Pruebas automáticas: 115 de API y 27 de interfaz, todas pasando.

## Lo que aprendí
`[Técnico: SQL, transacciones, seguridad, despliegue en Linux. No técnico: hablar con usuarios, priorizar, capacitar.]`

## Qué haría distinto
`[Ejemplo: migraciones desde el inicio, dinero en centavos enteros, probar los scripts de Windows antes.]`

## Enlaces
Repositorio: `[URL]` · Demo: `[URL]` · Video: `[URL]`
