pub const ANSWER: i32 = 42;

pub struct Thing {
    pub value: i32,
}

impl Thing {
    pub fn new(value: i32) -> Thing {
        Thing { value }
    }

    pub fn get(&self) -> i32 {
        self.value
    }
}

pub fn make_thing(value: i32) -> Thing {
    Thing { value }
}
