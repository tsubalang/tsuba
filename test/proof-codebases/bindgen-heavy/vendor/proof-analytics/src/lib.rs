pub mod metrics;
pub mod routing;

pub use metrics::{bucketize, Severity};
pub use routing::{classify_route, RouteClass};

pub trait Score {
    fn score(&self, value: i32) -> i32;
}

pub struct WeightedScorer {
    pub weight: i32,
    pub bias: i32,
}

impl WeightedScorer {
    pub fn new(weight: i32, bias: i32) -> Self {
        Self { weight, bias }
    }

    pub fn apply(&self, value: i32) -> i32 {
        (value * self.weight) + self.bias
    }

    pub fn apply_pair(&self, left: i32, right: i32) -> i32 {
        self.apply(left) + self.apply(right)
    }
}

impl Score for WeightedScorer {
    fn score(&self, value: i32) -> i32 {
        self.apply(value)
    }
}

pub fn weighted_sum(a: i32, b: i32, c: i32) -> i32 {
    (a * 2) + (b * 3) + c
}

pub fn stable_code(route_id: i32, status: i32) -> i32 {
    let route = classify_route(route_id);
    let sev = bucketize(status);
    let route_score = match route {
        RouteClass::Checkout => 40,
        RouteClass::Api => 20,
        RouteClass::Static => 5,
        RouteClass::Other => 8,
    };
    let sev_score = match sev {
        Severity::Ok => 1,
        Severity::Warn => 6,
        Severity::Error => 13,
    };
    route_score + sev_score + status
}
