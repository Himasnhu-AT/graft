; GDScript tags — graft's breadth tier. The tree-sitter-gdscript grammar ships no
; tags.scm upstream, so this is hand-written against its node vocabulary.
;
; A script file IS a class in GDScript. When it declares `class_name`, the whole
; `source` node is captured as that class's definition, so its span covers the
; file: the functions and vars nest inside it, and a reference made at the top
; level (`extends Base`, a typed member var) has the class as its source.

; Script class: `class_name Hero`
(source
  (class_name_statement
    name: (name) @name)) @definition.class

; Inner class: `class Inner extends Node:`
(class_definition
  name: (name) @name) @definition.class

; Functions. Script-level ones are functions; an inner class's are methods.
; `static func` has the same shape. Anchored on the container so a nested
; lambda or an inner-class method is not captured twice.
(source
  (function_definition
    name: (name) @name) @definition.function)

(class_body
  (function_definition
    name: (name) @name) @definition.method)

; `func _init():` — the constructor's name is a keyword token, not a (name).
(constructor_definition
  "_init" @name) @definition.method

; Signals, enums, constants and member vars (`@export`/`@onready`/`static var`
; included). Only script- and class-level ones: a local var is not a symbol.
(source
  (signal_statement
    name: (name) @name) @definition.field)

(class_body
  (signal_statement
    name: (name) @name) @definition.field)

(enum_definition
  name: (name) @name) @definition.enum

(source
  (const_statement
    name: (name) @name) @definition.constant)

(class_body
  (const_statement
    name: (name) @name) @definition.constant)

(source
  (variable_statement
    name: (name) @name) @definition.variable)

(class_body
  (variable_statement
    name: (name) @name) @definition.variable)

; Calls: `helper()`, and the method in `obj.run()` / `self.jump()` /
; `get_tree().create_timer()` / `Helper.make()`. `super._ready()` calls the parent
; script's override, not this one, so it is not reported (by name it would land
; on the caller itself). `Foo.new()` is a construction, reported below as a
; reference to Foo; `load`/`preload` are imports, not calls.
((call
  . (identifier) @name) @reference.call
  (#not-any-of? @name "preload" "load"))

((attribute
  . (_) @_receiver
  (attribute_call
    . (identifier) @name) @reference.call)
  (#not-eq? @_receiver "super")
  (#not-eq? @name "new"))

; Class references: `extends Base`, `Foo.new()`, `Foo.CONST` / `Foo.static_fn()`,
; and type annotations (`var g: GameState`, `-> Hero`). Restricted to
; capitalised names, which is how GDScript spells classes; built-in engine
; classes simply resolve to nothing and are dropped.
(extends_statement
  (type
    (identifier) @name)) @reference.class

((attribute
  . (identifier) @name) @reference.class
  (#match? @name "^[A-Z]"))

((type
  (identifier) @name) @reference.class
  (#match? @name "^[A-Z]"))
