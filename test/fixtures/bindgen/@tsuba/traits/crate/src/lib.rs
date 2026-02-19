pub trait Reader {
    fn read(&self) -> i32;
}

pub trait IteratorLike {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
}

pub trait Mapper<T>: IteratorLike {
    fn map_one(&self, value: T) -> Option<T>;
}

pub struct Counter {
    pub value: i32,
}

impl Counter {
    pub fn new(value: i32) -> Counter {
        Counter { value }
    }
}

pub fn weird(value: impl Iterator<Item = i32>) -> i32 {
    value.count() as i32
}
