pub enum RouteClass {
    Checkout,
    Api,
    Static,
    Other,
}

pub fn classify_route(route_id: i32) -> RouteClass {
    if route_id == 1 {
        return RouteClass::Checkout;
    }
    if route_id == 2 {
        return RouteClass::Api;
    }
    if route_id == 3 {
        return RouteClass::Static;
    }
    RouteClass::Other
}
