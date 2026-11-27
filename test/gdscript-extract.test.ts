/**
 * GDScript (Godot) on the breadth tier: the tree-sitter-gdscript grammar from the
 * tree-sitter-wasm bundle plus graft's own queries/gdscript.scm (the grammar ships
 * no tags.scm). These pin the symbols a script yields, the call and class edges
 * the existing resolver settles, and `res://` loads becoming file imports.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmGenericGrammars, extractGeneric, genericLangOf, isWarm } from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { skeleton } from "../src/ask/ask.js";
import type { NodeV1 } from "../src/graph/types.js";
import type { RawEdge } from "../src/graph/extract.js";

const HERO = `extends CharacterBody3D
class_name Hero

signal hit(amount: int)
enum State { IDLE, WALK }
const SPEED := 4.0
@export var health: int = 10
var game: GameState

func _ready() -> void:
\tsuper._ready()
\tvar g := GameState.new()
\t_step(2)
\tvar double := func(x): return x * 2

static func make() -> Hero:
\treturn Hero.new()

func _step(d: float) -> void:
\tvar local := 1
\tprint(d + local)

class Inner extends Node:
\tfunc go() -> void:
\t\tpass

func _init():
\tpass
`;

const GAME_STATE = `extends Node
class_name GameState

func save_game() -> bool:
\treturn true
`;

function extractAll(files: Record<string, string>): { nodes: NodeV1[]; raw: RawEdge[] } {
  const nodes: NodeV1[] = [];
  const raw: RawEdge[] = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "gdscript");
    nodes.push(...r.nodes);
    raw.push(...r.rawEdges);
  }
  return { nodes, raw };
}

test("genericLangOf routes .gd to the gdscript breadth grammar", () => {
  // Arrange / Act
  const lang = genericLangOf("scripts/player/hero.gd");

  // Assert
  assert.equal(lang?.name, "gdscript");
});

test("a GDScript file yields its class, members and functions, but no locals", async () => {
  // Arrange
  await warmGenericGrammars(["gdscript"]);
  assert.ok(isWarm("gdscript"), "gdscript grammar warms");

  // Act
  const { nodes } = extractGeneric("scripts/hero.gd", HERO, "gdscript");

  // Assert
  const kinds = nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(kinds, [
    "class:Hero", "class:Inner", "constant:SPEED", "enum:State",
    "function:_ready", "function:_step", "function:make",
    "method:_init", "method:go",
    "variable:game", "variable:health", "variable:hit",
  ]);
  const hero = nodes.find((n) => n.name === "Hero");
  assert.equal(hero?.span, `L1-L${HERO.split("\n").length}`, "class_name's class spans the whole script");
});

test("GDScript calls resolve by name, and super.f() is not a call to the caller itself", async () => {
  // Arrange
  await warmGenericGrammars(["gdscript"]);
  const { nodes, raw } = extractAll({ "scripts/hero.gd": HERO, "scripts/game_state.gd": GAME_STATE });

  // Act
  const calls = resolveEdges(nodes, raw).filter((e) => e.relation === "calls");

  // Assert
  assert.ok(
    calls.some((e) => e.source === "scripts/hero.gd#_ready" && e.target === "scripts/hero.gd#_step"),
    "_ready → _step resolves in-file",
  );
  assert.ok(
    !calls.some((e) => e.source === "scripts/hero.gd#_ready" && e.target === "scripts/hero.gd#_ready"),
    "super._ready() does not become a self-call",
  );
});

test("a class_name is project-global: Foo.new() and a type annotation reference it across files", async () => {
  // Arrange
  await warmGenericGrammars(["gdscript"]);
  const { nodes, raw } = extractAll({ "scripts/hero.gd": HERO, "scripts/game_state.gd": GAME_STATE });

  // Act
  const refs = resolveEdges(nodes, raw).filter((e) => e.relation === "references");

  // Assert
  const target = "scripts/game_state.gd#GameState";
  assert.ok(refs.some((e) => e.source === "scripts/hero.gd#_ready" && e.target === target), "GameState.new() in _ready");
  assert.ok(refs.some((e) => e.source === "scripts/hero.gd#game" && e.target === target), "var game: GameState");
  assert.ok(!refs.some((e) => String(e.target).includes("CharacterBody3D")), "an engine class resolves to nothing");
});

test("res:// preload, load and extends paths become file imports, never guessed", async () => {
  // Arrange
  await warmGenericGrammars(["gdscript"]);
  const files = {
    "game/scripts/base.gd": "extends Node\n",
    "game/scripts/util.gd": "extends RefCounted\n",
    "game/scripts/a/dup.gd": "extends Node\n",
    "other/scripts/a/dup.gd": "extends Node\n",
    "game/scripts/player.gd": [
      'extends "res://scripts/base.gd"',
      'const Util = preload("res://scripts/util.gd")',
      'const Dup = preload("res://scripts/a/dup.gd")',
      "func f():",
      '\tvar scene = load("res://scenes/main.tscn")',
      "\tvar dyn = load(\"res://scripts/\" + name)",
      "",
    ].join("\n"),
  };
  const { nodes, raw } = extractAll(files);

  // Act
  const targets = resolveEdges(nodes, raw)
    .filter((e) => e.relation === "imports" && e.source === "game/scripts/player.gd")
    .map((e) => e.target)
    .sort();

  // Assert: the project root (game/) is found by suffix; an ambiguous suffix and a
  // non-script resource stay as their res:// strings; a computed path is skipped.
  assert.deepEqual(targets, [
    "game/scripts/base.gd",
    "game/scripts/util.gd",
    "res://scenes/main.tscn",
    "res://scripts/a/dup.gd",
  ]);
});

test("a Godot project builds end to end and its script skeleton lists the API", async () => {
  // Arrange
  const dir = mkdtempSync(join(tmpdir(), "graft-gdscript-"));
  mkdirSync(join(dir, "game", "scripts"), { recursive: true });
  writeFileSync(join(dir, "game", "project.godot"), "config_version=5\n");
  writeFileSync(join(dir, "game", "scripts", "hero.gd"), HERO);
  writeFileSync(join(dir, "game", "scripts", "game_state.gd"), GAME_STATE);

  // Act
  await buildGraph(dir, { reuse: false });
  const r = skeleton(dir, "game/scripts/hero.gd");

  // Assert
  const names = r.entries.map((e) => e.name);
  for (const want of ["Hero", "_ready", "make", "_step", "Inner", "health"]) {
    assert.ok(names.includes(want), `skeleton includes ${want} (got ${names.join(", ")})`);
  }
});
