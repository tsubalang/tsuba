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
    Pair { left: T, right: T },
}

pub trait Service<T>: Clone {
    type Output;
    fn run(&self, input: T) -> Self::Output;
}

pub trait Named {
    fn label(&self) -> i32;
}

impl Named for Wrapper<i32> {
    fn label(&self) -> i32 {
        self.value
    }
}

pub fn fold_pair<T>(left: T, _right: T) -> T {
    left
}

#[proc_macro]
pub fn mk_tokens(input: proc_macro::TokenStream) -> proc_macro::TokenStream {
    input
}

#[proc_macro_attribute]
pub fn traced(_attr: proc_macro::TokenStream, item: proc_macro::TokenStream) -> proc_macro::TokenStream {
    item
}

#[proc_macro_derive(Serialize)]
pub fn derive_serialize(input: proc_macro::TokenStream) -> proc_macro::TokenStream {
    input
}
