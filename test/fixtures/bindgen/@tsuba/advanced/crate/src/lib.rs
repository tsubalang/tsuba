pub mod nested;

#[macro_export]
macro_rules! make_pair {
    ($a:expr, $b:expr) => {
        ($a, $b)
    };
}

pub struct Wrapper<T> {
    pub value: T,
}

impl<T> Wrapper<T> {
    pub fn new(value: T) -> Wrapper<T> {
        Wrapper { value }
    }

    pub fn map<U>(&self, value: U) -> U {
        value
    }
}

pub enum Payload<T> {
    Empty,
    One(T),
}

pub trait Service<T>: Clone {
    type Output;
    fn run(&self, input: T) -> Self::Output;
}

pub fn fold_pair<T>(left: T, _right: T) -> T {
    left
}
