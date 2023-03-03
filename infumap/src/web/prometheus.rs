// // Copyright (C) 2023 The Infumap Authors
// // This file is part of Infumap.
// //
// // This program is free software: you can redistribute it and/or modify
// // it under the terms of the GNU Affero General Public License as
// // published by the Free Software Foundation, either version 3 of the
// // License, or (at your option) any later version.
// //
// // This program is distributed in the hope that it will be useful,
// // but WITHOUT ANY WARRANTY; without even the implied warranty of
// // MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// // GNU Affero General Public License for more details.
// //
// // You should have received a copy of the GNU Affero General Public License
// // along with this program.  If not, see <https://www.gnu.org/licenses/>.

// use config::Config;
// use rocket_prometheus::PrometheusMetrics;
// use crate::web::routes::files::METRIC_CACHED_IMAGE_REQUESTS_TOTAL;
// use crate::web::routes::command::METRIC_COMMANDS_HANDLED_TOTAL;
// use crate::config::CONFIG_ENABLE_PROMETHEUS_METRICS;
// use rocket::{Build, Rocket};


// pub fn mount(config: &Config, build: Rocket<Build>) -> Rocket<Build> {
//   if config.get_bool(CONFIG_ENABLE_PROMETHEUS_METRICS).unwrap() {
//     let prometheus = PrometheusMetrics::new();
//     prometheus.registry().register(Box::new(METRIC_CACHED_IMAGE_REQUESTS_TOTAL.clone())).unwrap();
//     prometheus.registry().register(Box::new(METRIC_COMMANDS_HANDLED_TOTAL.clone())).unwrap();  
//     build
//       .attach(prometheus.clone())
//       .mount("/metrics", prometheus)
//   } else {
//     build
//   }
// }
