pub mod deep;

pub struct Bytes<const N: usize> {
    pub data: [u8; N],
}

pub enum Event {
    Ready,
    Message(String),
}

pub trait Borrowing<'a> {
    type Item;
    fn get(&'a self) -> Option<&'a Self::Item>;
}

pub fn first<'a>(value: &'a str) -> &'a str {
    value
}

pub fn take_iter(value: impl Iterator<Item = i32>) -> i32 {
    value.count() as i32
}
