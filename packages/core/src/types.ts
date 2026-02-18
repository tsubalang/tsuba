// @tsuba/core/types.js
// Marker types only. Tsuba erases these at compile time.

// Signed integers
export type i8 = number;
export type i16 = number;
export type i32 = number;
export type i64 = number;
export type isize = number;

// Unsigned integers
export type u8 = number;
export type u16 = number;
export type u32 = number;
export type u64 = number;
export type usize = number;

// Floats
export type f16 = number;
export type bf16 = number;
export type f32 = number;
export type f64 = number;

// Other primitives
export type bool = boolean;

// Explicit string marker (maps to Rust `std::string::String`)
export type String = string;

// Borrowed string marker (maps to Rust `str`; only valid behind `ref`/`mutref`)
export type Str = string;

// Borrow markers
export type ref<T> = T;
export type mutref<T> = T;
export type refLt<L extends string, T> = T & (L extends string ? unknown : never);
export type mutrefLt<L extends string, T> = T & (L extends string ? unknown : never);

// Local mutability marker (maps to `let mut`)
export type mut<T> = T;

// Option/Result (Rust-faithful discriminated unions)
export type Option<T> =
  | { readonly some: true; readonly value: T }
  | { readonly some: false };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// Macro/attribute marker types (see spec/macros.md)
export type Tokens = { readonly __tsuba_tokens: unique symbol };
export type Attr = { readonly __tsuba_attr: unique symbol };
export type DeriveMacro = { readonly __tsuba_derive: unique symbol };

export type Macro<Fn extends (...args: any[]) => unknown> = Fn & {
  readonly __tsuba_macro: unique symbol;
};

export type AttrMacro<Fn extends (...args: any[]) => Attr> = Fn & {
  readonly __tsuba_attr_macro: unique symbol;
};
