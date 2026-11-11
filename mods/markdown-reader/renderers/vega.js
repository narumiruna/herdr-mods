import { MAX_SVG_BYTES, sanitizeSvg } from "./svg.js"

let modules
const marks = new Set([
  "bar",
  "line",
  "point",
  "area",
  "circle",
  "square",
  "tick",
  "rule",
  "rect",
  "text",
  "trail",
  "arc",
])
const forbidden = new Set([
  "url",
  "href",
  "signal",
  "params",
  "selection",
  "bind",
  "on",
  "init",
  "update",
  "lookup",
  "sequence",
  "window",
  "density",
  "regression",
  "loess",
  "impute",
  "pivot",
  "flatten",
  "fold",
  "sample",
  "usermeta",
  "__proto__",
  "prototype",
  "constructor",
])
const rootKeys = new Set([
  "$schema",
  "data",
  "datasets",
  "mark",
  "encoding",
  "width",
  "height",
  "title",
  "description",
  "config",
  "transform",
  "layer",
  "concat",
  "hconcat",
  "vconcat",
  "columns",
  "spacing",
  "resolve",
  "facet",
  "repeat",
  "spec",
])
const channels = new Set([
  "x",
  "y",
  "x2",
  "y2",
  "color",
  "fill",
  "stroke",
  "opacity",
  "size",
  "shape",
  "text",
  "detail",
  "order",
])
const aggregates = new Set([
  "count",
  "valid",
  "missing",
  "distinct",
  "sum",
  "mean",
  "average",
  "median",
  "min",
  "max",
  "q1",
  "q3",
  "stdev",
  "stdevp",
  "variance",
  "variancep",
  "stderr",
])
const functions = new Set([
  "abs",
  "ceil",
  "floor",
  "round",
  "sqrt",
  "pow",
  "min",
  "max",
  "log",
  "exp",
  "sin",
  "cos",
  "tan",
  "isValid",
  "isFinite",
  "isNumber",
  "toNumber",
  "toString",
  "lower",
  "upper",
  "trim",
  "substring",
  "length",
  "year",
  "month",
  "date",
  "day",
  "hours",
  "minutes",
  "seconds",
  "datetime",
  "utc",
])
const configKeys = new Set([
  "background",
  "font",
  "fontSize",
  "color",
  "axis",
  "axisX",
  "axisY",
  "legend",
  "title",
  "view",
  "mark",
  "bar",
  "line",
  "point",
  "area",
  "range",
  "scale",
])

function fail(message) {
  throw new Error(`Vega-Lite: ${message}`)
}
function keys(value, allowed, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    fail(`unsupported ${label}`)
}
function rows(values) {
  if (!Array.isArray(values) || values.length > 5000) fail("inline data row limit exceeded")
  for (const row of values) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length > 100)
      fail("expected scalar data rows")
    if (Object.keys(row).some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
      fail("unsafe data field")
    for (const value of Object.values(row)) {
      if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1e12))
        fail("numeric data limit exceeded")
      if (value !== null && !["string", "number", "boolean"].includes(typeof value))
        fail("expected scalar data rows")
      if (typeof value === "string" && value.length > 4096) fail("data string limit exceeded")
    }
  }
  return values
}

// The authored expression subset has no loops, regex, resource/data access,
// dynamic properties, array/object constructors, or string expansion functions.
function expression(text, parseExpression, numericFields = new Set()) {
  if (typeof text !== "string" || text.length > 512) fail("expression length limit exceeded")
  const ast = parseExpression(text)
  let count = 0
  const numeric = (node) => {
    if (node.type === "Literal") return typeof node.value === "number"
    if (node.type === "Identifier") return ["PI", "E", "NaN"].includes(node.name)
    if (node.type === "MemberExpression")
      return numericFields.has(node.property.name || node.property.value)
    if (node.type === "UnaryExpression") return ["+", "-"].includes(node.operator)
    if (node.type === "BinaryExpression") return ["+", "-", "*", "/", "%"].includes(node.operator)
    if (node.type === "CallExpression")
      return !["toString", "lower", "upper", "trim", "substring", "datetime", "utc"].includes(
        node.callee.name,
      )
    if (node.type === "ConditionalExpression")
      return numeric(node.consequent) && numeric(node.alternate)
    return false
  }
  const visit = (node, depth = 0) => {
    if (++count > 100 || depth > 16) fail("expression complexity limit exceeded")
    switch (node.type) {
      case "Literal":
        if (
          node.regex ||
          node.value instanceof RegExp ||
          (node.value !== null && !["string", "number", "boolean"].includes(typeof node.value))
        )
          fail("unsafe expression literal")
        break
      case "Identifier":
        if (!["datum", "PI", "E", "NaN"].includes(node.name)) fail("unsafe expression identifier")
        break
      case "MemberExpression":
        if (node.object.type !== "Identifier" || node.object.name !== "datum")
          fail("only datum fields are allowed")
        if (
          node.computed
            ? node.property.type !== "Literal" || typeof node.property.value !== "string"
            : node.property.type !== "Identifier"
        )
          fail("dynamic expression field")
        if (
          ["__proto__", "prototype", "constructor"].includes(
            node.property.name || node.property.value,
          )
        )
          fail("unsafe expression field")
        break
      case "CallExpression":
        if (
          node.callee.type !== "Identifier" ||
          !functions.has(node.callee.name) ||
          node.arguments.length > 8
        )
          fail("unsafe expression function")
        for (const argument of node.arguments) visit(argument, depth + 1)
        break
      case "BinaryExpression":
      case "LogicalExpression":
        if (
          ![
            "+",
            "-",
            "*",
            "/",
            "%",
            "<",
            "<=",
            ">",
            ">=",
            "==",
            "!=",
            "===",
            "!==",
            "&&",
            "||",
          ].includes(node.operator)
        )
          fail("unsafe expression operator")
        visit(node.left, depth + 1)
        visit(node.right, depth + 1)
        if (node.operator === "+" && (!numeric(node.left) || !numeric(node.right)))
          fail("string-expanding addition is disabled")
        break
      case "UnaryExpression":
        if (!["+", "-", "!"].includes(node.operator)) fail("unsafe unary operator")
        visit(node.argument, depth + 1)
        break
      case "ConditionalExpression":
        visit(node.test, depth + 1)
        visit(node.consequent, depth + 1)
        visit(node.alternate, depth + 1)
        break
      default:
        fail("unsafe expression syntax")
    }
  }
  visit(ast)
  return numeric(ast)
}

function bin(value) {
  if (value === true || value === false || value === "binned") return
  keys(value, new Set(["maxbins"]), "bin settings")
  if (!Number.isInteger(value.maxbins) || value.maxbins < 1 || value.maxbins > 100)
    fail("bin count limit exceeded")
}

function transform(value, parseExpression, data) {
  if (!Array.isArray(value) || value.length > 8) fail("transform count limit exceeded")
  const numericFields = new Set(
    Object.keys(data[0] || {}).filter((field) =>
      data.every((row) => typeof row[field] === "number"),
    ),
  )
  for (const item of value) {
    if (item.calculate !== undefined) {
      keys(item, new Set(["calculate", "as"]), "calculate transform")
      const isNumeric = expression(item.calculate, parseExpression, numericFields)
      if (typeof item.as !== "string" || item.as.length > 100) fail("invalid calculated field")
      if (isNumeric) numericFields.add(item.as)
      else numericFields.delete(item.as)
    } else if (item.filter !== undefined) {
      keys(item, new Set(["filter"]), "filter transform")
      if (typeof item.filter === "string") expression(item.filter, parseExpression, numericFields)
      else
        keys(
          item.filter,
          new Set([
            "field",
            "equal",
            "lt",
            "lte",
            "gt",
            "gte",
            "range",
            "oneOf",
            "valid",
            "timeUnit",
          ]),
          "filter predicate",
        )
    } else if (item.aggregate !== undefined || item.joinaggregate !== undefined) {
      numericFields.clear()
      const name = item.aggregate ? "aggregate" : "joinaggregate"
      keys(item, new Set([name, "groupby"]), "aggregate transform")
      if (!Array.isArray(item[name]) || item[name].length > 16)
        fail("aggregate count limit exceeded")
      for (const aggregate of item[name]) {
        keys(aggregate, new Set(["op", "field", "as"]), "aggregate operation")
        if (!aggregates.has(aggregate.op)) fail("unsupported aggregate")
      }
    } else if (item.bin !== undefined) {
      numericFields.clear()
      keys(item, new Set(["bin", "field", "as"]), "bin transform")
      bin(item.bin)
    } else if (item.timeUnit !== undefined) {
      numericFields.clear()
      keys(item, new Set(["timeUnit", "field", "as"]), "time unit transform")
      if (typeof item.timeUnit !== "string") fail("unsupported time unit")
    } else fail("unsupported transform")
  }
}

export function validateVega(source, parseExpression) {
  const spec = JSON.parse(source)
  const datasets = spec.datasets || {}
  keys(datasets, new Set(Object.keys(datasets)), "datasets")
  let totalRows = 0
  for (const [name, value] of Object.entries(datasets)) {
    if (!/^[\w-]+$/.test(name) || ["__proto__", "prototype", "constructor"].includes(name))
      fail("unsafe dataset name")
    totalRows += rows(value).length
  }
  let nodes = 0
  const scan = (value, depth = 0) => {
    if (++nodes > 20000 || depth > 24) fail("complexity limit exceeded")
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 1e12))
      fail("numeric limit exceeded")
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        // Data cells are scalar values, not configuration or executable references.
        if (value === spec && key === "datasets") continue
        if (
          key === "data" &&
          child &&
          Object.keys(child).length === 1 &&
          Array.isArray(child.values)
        ) {
          rows(child.values)
          continue
        }
        if (forbidden.has(key) || /expr|signal/i.test(key)) fail(`unsafe property ${key}`)
        if (key === "test" && typeof child === "string") expression(child, parseExpression)
        if (
          ["tickCount", "count"].includes(key) &&
          (!Number.isInteger(child) || child < 1 || child > 100)
        )
          fail("count limit exceeded")
        if (["tickMinStep", "bins", "step"].includes(key))
          fail(`unsupported generator setting ${key}`)
        if (key === "nice" && typeof child !== "boolean") fail("unsupported scale nice")
        if (key === "timeUnit" && typeof child !== "string") fail("unsupported time unit")
        if (key === "bin") bin(child)
        if (key === "aggregate" && typeof child === "string" && !aggregates.has(child))
          fail("unsupported aggregate")
        scan(child, depth + 1)
      }
    }
  }
  scan(spec)
  const availableRows = (data, inherited) => {
    if (!data) return inherited
    if (Object.keys(data).length !== 1) fail("only inline data is allowed")
    if (data.values) {
      const result = rows(data.values)
      totalRows += result.length
      return result
    }
    if (typeof data.name === "string" && Object.hasOwn(datasets, data.name))
      return datasets[data.name]
    fail("only inline data is allowed")
  }
  let views = 0
  let rowViews = 0
  const walk = (node, inherited = [], multiplier = 1, depth = 0, transformed = false) => {
    keys(node, rootKeys, "chart property")
    if (depth && node.datasets) fail("datasets must be at the chart root")
    const inheritedTransforms = transformed
    transformed ||= Boolean(node.transform?.length)
    if (depth > 4 || multiplier > 16) fail("composition limit exceeded")
    if (
      node.$schema &&
      !/^https:\/\/vega\.github\.io\/schema\/vega-lite\/v[\d.]+\.json$/.test(node.$schema)
    )
      fail("unsupported schema")
    for (const key of ["width", "height"]) {
      if (
        node[key] !== undefined &&
        (!Number.isFinite(node[key]) || node[key] < 1 || node[key] > 2048)
      )
        fail(`invalid ${key}`)
    }
    if (
      node.columns !== undefined &&
      (!Number.isInteger(node.columns) || node.columns < 1 || node.columns > 8)
    )
      fail("column limit exceeded")
    if (node.config) keys(node.config, configKeys, "config")
    const data = availableRows(node.data, inherited)
    if (node.transform) transform(node.transform, parseExpression, inheritedTransforms ? [] : data)
    const compositions = ["layer", "concat", "hconcat", "vconcat", "facet", "repeat"].filter(
      (key) => node[key] !== undefined,
    )
    if (compositions.length > 1 || (compositions.length && node.mark)) fail("ambiguous composition")
    const composition = compositions[0]
    if (["layer", "concat", "hconcat", "vconcat"].includes(composition)) {
      const children = node[composition]
      if (!Array.isArray(children) || !children.length || children.length > 8)
        fail("composition count limit exceeded")
      for (const child of children) walk(child, data, multiplier, depth + 1, transformed)
    } else if (composition === "repeat") {
      const repeat = node.repeat
      const counts = Array.isArray(repeat)
        ? [repeat.length]
        : Object.values(repeat).map((fields) => (Array.isArray(fields) ? fields.length : 100))
      if (!counts.length || counts.some((n) => !n || n > 8)) fail("repeat limit exceeded")
      walk(node.spec, data, multiplier * counts.reduce((a, b) => a * b, 1), depth + 1, transformed)
    } else if (composition === "facet") {
      const facet = node.facet
      const definitions = facet.field ? [facet] : Object.values(facet)
      if (!definitions.length || definitions.length > 2) fail("unsupported facet")
      let count = 1
      for (const definition of definitions) {
        if (typeof definition.field !== "string" || definition.bin || definition.timeUnit)
          fail("only field facets are supported")
        const unknown = transformed || data.some((row) => !Object.hasOwn(row, definition.field))
        count *= Math.max(
          1,
          unknown ? data.length : new Set(data.map((row) => row[definition.field])).size,
        )
      }
      walk(node.spec, data, multiplier * count, depth + 1, transformed)
    } else {
      const mark = typeof node.mark === "string" ? node.mark : node.mark?.type
      if (!marks.has(mark)) fail("unsupported mark")
      if (node.encoding) {
        for (const channel of Object.keys(node.encoding))
          if (!channels.has(channel)) fail(`unsupported channel ${channel}`)
      }
      views += multiplier
      rowViews += multiplier * data.length
      if (views > 16 || rowViews > 20000) fail("expanded view limit exceeded")
    }
  }
  walk(spec)
  if (totalRows > 5000) fail("total row limit exceeded")
  return spec
}

export async function renderVega(source, options) {
  modules ||= Promise.all([import("vega-lite"), import("vega")])
  const [{ compile }, vega] = await modules
  const spec = validateVega(source, vega.parseExpression)
  const color = options.foreground
  const unit = spec.mark !== undefined
  const compiled = compile(
    {
      ...spec,
      ...(unit
        ? { width: spec.width || Math.min(options.width, 800), height: spec.height || 300 }
        : {}),
      config: {
        ...spec.config,
        background: options.background,
        font: options.fontFamily,
        mark: { color: options.accent, ...spec.config?.mark },
        axis: {
          ...spec.config?.axis,
          labelColor: color,
          titleColor: color,
          domainColor: color,
          tickColor: color,
          gridColor: options.dark ? "#444444" : "#dddddd",
        },
        legend: { ...spec.config?.legend, labelColor: color, titleColor: color },
        title: { ...spec.config?.title, color },
        view: { ...spec.config?.view, stroke: "transparent" },
      },
    },
    {
      logger: {
        warn() {},
        info() {},
        debug() {},
        error(message) {
          throw new Error(String(message))
        },
      },
    },
  ).spec
  const deny = async () => {
    throw new Error("Vega resource loading is disabled")
  }
  const view = new vega.View(vega.parse(compiled), {
    renderer: "none",
    loader: { load: deny, sanitize: deny },
    logLevel: vega.Error,
  })
  try {
    await view.runAsync()
    const svg = await view.toSVG()
    if (Buffer.byteLength(svg) > MAX_SVG_BYTES) throw new Error("SVG output limit exceeded")
    const width = Number(/\bwidth="([\d.]+)"/.exec(svg)?.[1])
    const height = Number(/\bheight="([\d.]+)"/.exec(svg)?.[1])
    return sanitizeSvg(svg, { ...options, width, height })
  } finally {
    view.finalize()
  }
}
