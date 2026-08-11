import { z } from 'zod';

export interface FlatProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: FlatProperty;
  properties?: Record<string, FlatProperty>;
  required?: string[];
}

export interface FlatSchema {
  type: 'object';
  properties: Record<string, FlatProperty>;
  required: string[];
  additionalProperties: false;
}

export class UnsupportedSchema extends Error {}

/**
 * Подмножество, которое понимают все: строки, числа, логические, перечисления и
 * массивы объектов. Ни anyOf, ни oneOf, ни глубокой вложенности — часть провайдеров
 * их просто отбрасывает вместе с полем.
 */
export function toFlatSchema(schema: z.ZodTypeAny, maxDescription = 240): FlatSchema {
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject)) throw new UnsupportedSchema('на входе ожидался объект');

  const properties: Record<string, FlatProperty> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(object.shape as Record<string, z.ZodTypeAny>)) {
    properties[key] = toProperty(value, maxDescription, 0);
    if (!isOptional(value)) required.push(key);
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

function toProperty(schema: z.ZodTypeAny, maxDescription: number, depth: number): FlatProperty {
  if (depth > 2) throw new UnsupportedSchema('слишком глубокая вложенность для формата функций');

  const description = schema.description;
  const inner = unwrap(schema);
  const property = describe(inner, maxDescription, depth);
  if (description) property.description = shorten(description, maxDescription);
  return property;
}

function describe(schema: z.ZodTypeAny, maxDescription: number, depth: number): FlatProperty {
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: schema.isInt ? 'integer' : 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...(schema.options as string[])] };
  if (schema instanceof z.ZodLiteral) return { type: 'string', enum: [String(schema.value)] };

  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: toProperty(schema.element as z.ZodTypeAny, maxDescription, depth + 1) };
  }

  if (schema instanceof z.ZodObject) {
    const properties: Record<string, FlatProperty> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      properties[key] = toProperty(value, maxDescription, depth + 1);
      if (!isOptional(value)) required.push(key);
    }
    return { type: 'object', properties, required };
  }

  throw new UnsupportedSchema(`тип ${schema.constructor.name} не переводится в формат функций`);
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (let i = 0; i < 10; i += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    return current;
  }
  return current;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.isOptional() || schema instanceof z.ZodDefault;
}

export function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return lastStop > limit / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}
