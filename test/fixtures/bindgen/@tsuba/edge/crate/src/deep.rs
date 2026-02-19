pub trait DeepTrait<T>: Clone {
    fn map<'a>(&'a self, value: T) -> Option<T>;
}
