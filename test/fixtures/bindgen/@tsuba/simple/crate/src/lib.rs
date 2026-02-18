pub const ANSWER: i32 = 42;

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub fn new(x: i32, y: i32) -> Point {
        Point { x, y }
    }

    pub fn sum(&self) -> i32 {
        self.x + self.y
    }

    pub fn origin() -> Point {
        Point { x: 0, y: 0 }
    }
}

pub enum Color {
    Red,
    Green,
}

pub mod math;

