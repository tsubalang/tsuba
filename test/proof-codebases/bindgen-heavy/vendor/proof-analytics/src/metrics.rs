pub enum Severity {
    Ok,
    Warn,
    Error,
}

pub fn bucketize(status: i32) -> Severity {
    if status >= 500 {
        return Severity::Error;
    }
    if status >= 400 {
        return Severity::Warn;
    }
    Severity::Ok
}
