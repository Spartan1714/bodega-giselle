-- =====================================================
-- Esquema de base de datos: Sistema de inventario para abarrotería
-- Motor: PostgreSQL
-- =====================================================

-- ---------- Catálogos ----------

CREATE TABLE usuarios (
    id            SERIAL PRIMARY KEY,
    nombre        VARCHAR(100) NOT NULL,
    usuario       VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    rol           VARCHAR(20)  NOT NULL DEFAULT 'cajero'
                  CHECK (rol IN ('admin', 'cajero')),
    activo        BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE categorias (
    id     SERIAL PRIMARY KEY,
    nombre VARCHAR(80) NOT NULL UNIQUE
);

CREATE TABLE proveedores (
    id       SERIAL PRIMARY KEY,
    nombre   VARCHAR(120) NOT NULL,
    telefono VARCHAR(30),
    notas    TEXT
);

-- ---------- Productos ----------

CREATE TABLE productos (
    id               SERIAL PRIMARY KEY,
    nombre           VARCHAR(150) NOT NULL,
    categoria_id     INT REFERENCES categorias(id),
    unidad           VARCHAR(20) NOT NULL DEFAULT 'unidad',  -- unidad, libra, kg, caja...
    precio_venta     NUMERIC(12,2) NOT NULL CHECK (precio_venta >= 0),
    stock_minimo     NUMERIC(12,2) NOT NULL DEFAULT 0,       -- para alerta de reposición
    dias_alerta_venc INT NOT NULL DEFAULT 30,                -- avisar X días antes de vencer
    activo           BOOLEAN NOT NULL DEFAULT TRUE
);

-- Un producto puede tener varios códigos (distintas presentaciones o etiquetas propias)
CREATE TABLE codigos_barras (
    codigo      VARCHAR(50) PRIMARY KEY,
    producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE
);

-- ---------- Compras (entradas) ----------

CREATE TABLE compras (
    id           SERIAL PRIMARY KEY,
    proveedor_id INT REFERENCES proveedores(id),
    usuario_id   INT NOT NULL REFERENCES usuarios(id),
    fecha        TIMESTAMP NOT NULL DEFAULT NOW(),
    total        NUMERIC(12,2) NOT NULL DEFAULT 0,
    notas        TEXT
);

-- Cada línea de compra crea un LOTE con su propio vencimiento y costo
CREATE TABLE lotes (
    id              SERIAL PRIMARY KEY,
    producto_id     INT NOT NULL REFERENCES productos(id),
    compra_id       INT REFERENCES compras(id),
    cantidad_inicial NUMERIC(12,2) NOT NULL CHECK (cantidad_inicial > 0),
    cantidad_actual  NUMERIC(12,2) NOT NULL CHECK (cantidad_actual >= 0),
    costo_unitario   NUMERIC(12,2) NOT NULL CHECK (costo_unitario >= 0),
    fecha_vencimiento DATE,                -- NULL para productos que no vencen
    fecha_ingreso    DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX idx_lotes_producto ON lotes(producto_id);
CREATE INDEX idx_lotes_vencimiento ON lotes(fecha_vencimiento)
    WHERE cantidad_actual > 0;

-- ---------- Ventas (salidas) ----------

CREATE TABLE ventas (
    id         SERIAL PRIMARY KEY,
    usuario_id INT NOT NULL REFERENCES usuarios(id),
    fecha      TIMESTAMP NOT NULL DEFAULT NOW(),
    total      NUMERIC(12,2) NOT NULL DEFAULT 0,
    metodo_pago VARCHAR(20) NOT NULL DEFAULT 'efectivo'
                CHECK (metodo_pago IN ('efectivo', 'tarjeta', 'transferencia', 'credito'))
);

CREATE TABLE detalle_ventas (
    id              SERIAL PRIMARY KEY,
    venta_id        INT NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id     INT NOT NULL REFERENCES productos(id),
    lote_id         INT NOT NULL REFERENCES lotes(id),  -- de qué lote salió (FEFO)
    cantidad        NUMERIC(12,2) NOT NULL CHECK (cantidad > 0),
    precio_unitario NUMERIC(12,2) NOT NULL,             -- precio al momento de la venta
    costo_unitario  NUMERIC(12,2) NOT NULL              -- costo del lote, para calcular ganancia
);

-- ---------- Auditoría de inventario ----------

-- Registra TODO cambio de stock: compras, ventas, mermas, ajustes
CREATE TABLE movimientos_inventario (
    id         SERIAL PRIMARY KEY,
    lote_id    INT NOT NULL REFERENCES lotes(id),
    tipo       VARCHAR(20) NOT NULL
               CHECK (tipo IN ('compra', 'venta', 'merma', 'vencido', 'ajuste')),
    cantidad   NUMERIC(12,2) NOT NULL,      -- positivo entra, negativo sale
    fecha      TIMESTAMP NOT NULL DEFAULT NOW(),
    usuario_id INT REFERENCES usuarios(id),
    motivo     TEXT
);

-- ---------- Gastos (contabilidad básica) ----------

CREATE TABLE gastos (
    id          SERIAL PRIMARY KEY,
    fecha       DATE NOT NULL DEFAULT CURRENT_DATE,
    concepto    VARCHAR(150) NOT NULL,      -- luz, alquiler, salarios, transporte...
    monto       NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
    usuario_id  INT REFERENCES usuarios(id)
);

-- =====================================================
-- Consultas útiles (vistas)
-- =====================================================

-- Stock actual por producto, con alerta de stock bajo
CREATE VIEW v_stock_actual AS
SELECT p.id,
       p.nombre,
       COALESCE(SUM(l.cantidad_actual), 0) AS stock,
       p.stock_minimo,
       COALESCE(SUM(l.cantidad_actual), 0) <= p.stock_minimo AS stock_bajo
FROM productos p
LEFT JOIN lotes l ON l.producto_id = p.id
WHERE p.activo
GROUP BY p.id;

-- Lotes vencidos o por vencer según los días de alerta de cada producto
CREATE VIEW v_alertas_vencimiento AS
SELECT p.nombre,
       l.id AS lote_id,
       l.cantidad_actual,
       l.fecha_vencimiento,
       (l.fecha_vencimiento - CURRENT_DATE) AS dias_restantes,
       CASE WHEN l.fecha_vencimiento < CURRENT_DATE THEN 'VENCIDO'
            ELSE 'POR VENCER' END AS estado
FROM lotes l
JOIN productos p ON p.id = l.producto_id
WHERE l.cantidad_actual > 0
  AND l.fecha_vencimiento IS NOT NULL
  AND l.fecha_vencimiento <= CURRENT_DATE + p.dias_alerta_venc
ORDER BY l.fecha_vencimiento;

-- Valor del inventario (a costo)
CREATE VIEW v_valor_inventario AS
SELECT SUM(cantidad_actual * costo_unitario) AS valor_total
FROM lotes
WHERE cantidad_actual > 0;

-- Ganancia por día
CREATE VIEW v_ganancia_diaria AS
SELECT v.fecha::DATE AS dia,
       SUM(d.cantidad * d.precio_unitario) AS ventas,
       SUM(d.cantidad * d.costo_unitario)  AS costo,
       SUM(d.cantidad * (d.precio_unitario - d.costo_unitario)) AS ganancia
FROM ventas v
JOIN detalle_ventas d ON d.venta_id = v.id
GROUP BY v.fecha::DATE
ORDER BY dia DESC;
