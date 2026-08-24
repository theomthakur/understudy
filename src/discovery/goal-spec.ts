import type { InputParam, OutputField } from "../domain/artifact.js";

export type CliArgValue = string | boolean | string[];
export type CliArgs = Record<string, CliArgValue>;

export interface FreeFormGoalSpec {
  goal: string;
  name: string;
  title: string;
  description: string;
  inputs: InputParam[];
  outputs: OutputField[];
  inputValues: Record<string, string>;
  derivedName: boolean;
}

const VALID_TYPES = ["string", "number", "boolean", "currency"] as const;
type ParamType = typeof VALID_TYPES[number];

/** Parse the explicit contract that turns an arbitrary sentence into a reusable capability. */
export function parseFreeFormGoal(args: CliArgs): FreeFormGoalSpec {
  const goal = one(args, "goal").trim();
  if (!goal) throw new Error("--goal must contain a natural-language goal");

  const suppliedName = optionalOne(args, "name")?.trim();
  const inputs = many(args, "input").map(parseInput);
  const outputs = many(args, "output").map(parseOutput);
  const inputValues = Object.fromEntries(many(args, "value").map(parseValue));
  const declared = new Set(inputs.map((input) => input.name));
  const unknown = Object.keys(inputValues).filter((name) => !declared.has(name));
  if (unknown.length) throw new Error(`--value supplied for undeclared input(s): ${unknown.join(", ")}`);
  const missing = inputs.filter((input) => input.required && inputValues[input.name] === undefined);
  if (missing.length) throw new Error(`Missing --value for required input(s): ${missing.map((input) => input.name).join(", ")}`);

  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 56) || "capability";
  return {
    goal,
    name: suppliedName || `custom.${slug}`,
    title: goal.length > 90 ? `${goal.slice(0, 87)}…` : goal,
    description: goal,
    inputs,
    outputs,
    inputValues,
    derivedName: !suppliedName,
  };
}

function parseInput(spec: string): InputParam {
  const [shape, pattern] = splitOnce(spec, "=");
  const [name, rawType, modifier, ...extra] = shape.split(":");
  assertName(name, "input", spec);
  const type = parseType(rawType, "input", spec);
  if (extra.length || (modifier && modifier !== "sensitive")) {
    throw new Error(`Malformed --input "${spec}". Expected name:type[:sensitive][=pattern]`);
  }
  if (pattern !== undefined) {
    try { new RegExp(pattern); } catch { throw new Error(`Invalid regex in --input "${spec}"`); }
  }
  return {
    name,
    type,
    required: true,
    description: `Invocation value for ${name}`,
    sensitive: modifier === "sensitive",
    pattern,
  };
}

function parseOutput(spec: string): OutputField {
  const [name, rawType, modifier, ...extra] = spec.split(":");
  assertName(name, "output", spec);
  const type = parseType(rawType, "output", spec);
  if (extra.length || (modifier && modifier !== "sensitive")) {
    throw new Error(`Malformed --output "${spec}". Expected name:type[:sensitive]`);
  }
  return { name, type, description: `Declared result ${name}`, sensitive: modifier === "sensitive" };
}

function parseValue(spec: string): [string, string] {
  const [name, value] = splitOnce(spec, "=");
  assertName(name, "value", spec);
  if (value === undefined) throw new Error(`Malformed --value "${spec}". Expected name=value`);
  return [name, value];
}

function parseType(raw: string | undefined, kind: string, spec: string): ParamType {
  if (VALID_TYPES.includes(raw as ParamType)) return raw as ParamType;
  throw new Error(`Unknown ${kind} type "${raw ?? ""}" in "${spec}". Valid types: ${VALID_TYPES.join(", ")}`);
}

function assertName(name: string | undefined, kind: string, spec: string): asserts name is string {
  if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid ${kind} name in "${spec}"; use letters, digits, and underscores`);
  }
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, undefined] : [value.slice(0, at), value.slice(at + separator.length)];
}

function many(args: CliArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === false || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function one(args: CliArgs, key: string): string {
  const values = many(args, key);
  if (values.length !== 1) throw new Error(`--${key} must be supplied exactly once`);
  return values[0]!;
}

function optionalOne(args: CliArgs, key: string): string | undefined {
  const values = many(args, key);
  if (values.length > 1) throw new Error(`--${key} may be supplied only once`);
  return values[0];
}
