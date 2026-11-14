/*
  Copyright (C) The Infumap Authors
  This file is part of Infumap.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as
  published by the Free Software Foundation, either version 3 of the
  License, or (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// Loaded with import() when the item icon popup opens, so the tables stay out of the main bundle.

export interface EmojiCategory {
  name: string,
  emojis: Array<string>,
}

export const EMOJI_CATEGORIES: Array<EmojiCategory> = [
  {
    name: "Smileys & People",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "🙂", "🙃", "😉", "😊",
      "😍", "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪",
      "🤔", "🫡", "🤨", "😐", "😑", "😶", "🙄", "😏", "😴",
      "😮", "😲", "😳", "🥺", "😢", "😭", "😤", "😡", "🤒",
      "😎", "🤩", "🥳", "😇", "🤠", "🤓", "🫠", "🙋", "👋",
      "👍", "👎", "👏", "🙏", "🤝", "💪", "👀", "🧠", "👑",
      "👤", "👥", "👶", "👨‍👩‍👧", "🧑‍💻", "🧘", "🏃",
    ],
  },
  {
    name: "Animals & Nature",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨",
      "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦",
      "🐤", "🦆", "🦅", "🦉", "🦇", "🐺", "🐴", "🦄", "🐝",
      "🐛", "🦋", "🐌", "🐞", "🐜", "🕷️", "🐢", "🐍", "🦎",
      "🦖", "🐙", "🦑", "🦀", "🐠", "🐬", "🐳", "🦈", "🐘",
      "🐾", "🌱", "🌿", "🍀", "🌵", "🌲", "🌳", "🌴", "🪴",
      "🌸", "🌻", "🍂", "🌞", "🌙", "🌈", "☁️", "⛈️", "🌧️",
      "❄️", "💧", "🌊", "🌍",
    ],
  },
  {
    name: "Food & Drink",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓",
      "🫐", "🍒", "🍑", "🥭", "🍍", "🥥", "🥝", "🍅", "🥑",
      "🥦", "🥕", "🌽", "🌶️", "🥐", "🥯", "🍞", "🥨", "🧀",
      "🥚", "🍳", "🥞", "🥓", "🥩", "🍔", "🍟", "🍕", "🌭",
      "🥪", "🌮", "🌯", "🥗", "🍝", "🍜", "🍲", "🍚", "🍣",
      "🍱", "🥟", "🍦", "🍩", "🍪", "🎂", "🍰", "🍫", "🍿",
      "☕", "🍵", "🥛", "🥤", "🧃", "🍺", "🍷", "🍸", "🍹",
      "🥂", "🍽️", "🥄",
    ],
  },
  {
    name: "Travel & Places",
    emojis: [
      "🚗", "🚕", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚚",
      "🚲", "🛴", "🏍️", "🚂", "🚆", "🚇", "🚊", "✈️", "🚀",
      "🛸", "🚁", "⛵", "🚢", "⚓", "⛽", "🚧", "🚦", "🗺️",
      "🗽", "🗼", "🏰", "🏯", "🏟️", "🎡", "🎢", "🏠", "🏡",
      "🏢", "🏫", "🏥", "🏦", "🏨", "🏪", "🏛️", "⛪", "🕌",
      "🏖️", "🏝️", "🏜️", "🏔️", "⛰️", "🌋", "🏕️", "🌃", "🌉",
      "🧳",
    ],
  },
  {
    name: "Activities",
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🥏", "🎱",
      "🏓", "🏸", "🥅", "🏒", "🏑", "🏏", "🥍", "⛳", "🪁",
      "🏹", "🎣", "🥊", "🥋", "🎽", "🛹", "🛼", "⛸️", "🎿",
      "⛷️", "🏂", "🏋️", "🤸", "🤾", "🏌️", "🏄", "🚣", "🏊",
      "🎯", "🎮", "🕹️", "🎲", "🧩", "♟️", "🎭", "🎨", "🎬",
      "📺", "🎤", "🎙️", "🎧", "🎼", "🎵", "🎹", "🥁", "🎷",
      "🎺", "🎸", "🎻",
    ],
  },
  {
    name: "Events & Planning",
    emojis: [
      "🎈", "🎉", "🎊", "🎁", "🎀", "🪅", "🪩", "🎆", "🎇",
      "🧨", "🎃", "🎄", "🎅", "🤶", "🧑‍🎄", "🎋", "🎍", "🎎",
      "🎏", "🎐", "🎑", "🧧", "🎟️", "🎫", "🏆", "🥇", "🥈",
      "🥉", "🏅", "🎖️", "💐", "🌹", "📅", "📆", "🗓️", "⏰",
      "⏱️", "⏲️", "⌚", "⏳", "🧭", "🗒️", "📓", "📔", "📕",
      "📗", "📘", "📙", "🔖", "📋", "📊", "📈", "📉", "🧾",
      "📤", "📥", "📦", "✉️", "📧", "📮", "💼", "🗃️", "🗄️",
      "🗑️", "🛍️", "🛒",
    ],
  },
  {
    name: "Objects",
    emojis: [
      "💡", "🔦", "🕯️", "🧯", "🛠️", "🔧", "🔨", "⚙️", "🧰",
      "🧲", "🔌", "🔋", "🧪", "🧫", "🧬", "🔬", "🔭", "📡",
      "💉", "🩺", "💊", "🦷", "🚪", "🪑", "🛏️", "🛋️", "🚿",
      "🧴", "🧷", "🧵", "🪡", "🧹", "🧼", "🧽", "🫧", "🧺",
      "👕", "🎒", "🔑", "🗝️", "🔒", "🔓", "🔐", "🛡️", "🪪",
      "💰", "💵", "💳", "💎", "⚖️", "🧮", "📱", "💻", "⌨️",
      "🖥️", "🖨️", "💾", "📷", "🎥", "📞", "☎️", "🌐", "🤖",
      "📚", "📖", "📝", "✏️", "📄", "📰", "📜", "🎓", "📌",
      "📍", "✂️", "📎", "🔗", "🏷️", "📁", "🗂️",
    ],
  },
  {
    name: "Symbols",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔",
      "✅", "☑️", "✔️", "❌", "❎", "➕", "➖", "➗", "✖️",
      "❗", "❓", "‼️", "⁉️", "⚠️", "🚫", "🛑", "ℹ️", "🆕",
      "⭐", "🌟", "✨", "💫", "🔥", "💥", "💯", "⚡", "📣",
      "🔔", "🔕", "♻️", "▶️", "⏸️", "🔁", "🔄", "🔎", "💬",
      "💭", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "⚫", "⚪",
      "⬆️", "⬇️", "➡️", "⬅️", "↗️", "↘️", "↙️", "↖️", "🔙",
      "🔚", "🔜", "🔝",
    ],
  },
  {
    name: "Flags",
    emojis: [
      "🏁", "🚩", "🎌", "🏴", "🏳️", "🏳️‍🌈", "🇺🇸", "🇬🇧", "🇪🇺",
      "🇮🇹", "🇫🇷", "🇩🇪", "🇪🇸", "🇵🇹", "🇳🇱", "🇨🇭", "🇸🇪", "🇳🇴",
      "🇩🇰", "🇫🇮", "🇮🇪", "🇬🇷", "🇹🇷", "🇹🇭", "🇯🇵", "🇰🇷", "🇨🇳",
      "🇮🇳", "🇦🇺", "🇳🇿", "🇨🇦", "🇲🇽", "🇧🇷", "🇦🇷", "🇿🇦", "🇺🇦",
    ],
  },
];

// Words someone might type to find an icon. Keep to words people are likely to use: every extra word can pull an
// unrelated icon into a search, because each query word matches the start of any word here. Groups are kept small
// so a word only matches the icons it describes ("work" should not bring up the house).
const EMOJI_SEARCH_GROUPS: Array<{ emojis: string, terms: string }> = [
  // Smileys & People
  { emojis: "😀😃😄😁😆🙂😊", terms: "happy smile smiling grin grinning laugh laughing lol funny joy glad face" },
  { emojis: "🙃😉😏", terms: "wink winking playful smirk sarcastic face" },
  { emojis: "😍😘😗😙😚", terms: "love heart eyes kiss kissing crush face" },
  { emojis: "😋😛😜🤪", terms: "tongue tasty delicious yum silly goofy crazy face" },
  { emojis: "🤔🫡🤨😐😑😶🙄", terms: "thinking hmm salute skeptical suspicious neutral meh expressionless silent speechless eye roll whatever face" },
  { emojis: "😴😮😲😳🥺😢😭😤😡", terms: "sleep sleepy tired surprised shocked wow embarrassed pleading sad unhappy cry crying upset frustrated angry mad annoyed face" },
  { emojis: "😎🤩🥳😇🤠🤓🫠", terms: "cool sunglasses excited party angel innocent cowboy nerd geek melting face" },
  { emojis: "🤒", terms: "sick ill unwell fever health face" },
  { emojis: "🙋", terms: "raise hand question volunteer me person" },
  { emojis: "👋", terms: "wave hello hi bye goodbye greeting hand" },
  { emojis: "👍", terms: "thumbs up yes ok okay good like approve agree hand" },
  { emojis: "👎", terms: "thumbs down no bad dislike disagree reject hand" },
  { emojis: "👏", terms: "clap applause bravo congrats congratulations well done hands" },
  { emojis: "🙏", terms: "pray please thanks thank you grateful hope hands" },
  { emojis: "🤝", terms: "handshake deal agreement meeting partner partnership hands" },
  { emojis: "💪", terms: "strong strength muscle flex gym fitness workout exercise" },
  { emojis: "👀", terms: "eyes look looking watch see review" },
  { emojis: "🧠", terms: "brain think mind smart intelligence learn knowledge psychology" },
  { emojis: "👑", terms: "crown king queen royal vip best" },
  { emojis: "👤", terms: "person contact profile user account individual" },
  { emojis: "👥", terms: "people team group users contacts members" },
  { emojis: "👶", terms: "baby child infant kid newborn" },
  { emojis: "👨‍👩‍👧", terms: "family parents kids children home people" },
  { emojis: "🧑‍💻", terms: "developer programmer coder coding code programming software tech person" },
  { emojis: "🧘", terms: "meditate meditation yoga calm relax mindfulness wellbeing person" },
  { emojis: "🏃", terms: "run running runner jog exercise fitness hurry person" },

  // Animals & Nature
  { emojis: "🐶🐺🦊", terms: "dog puppy wolf fox canine pet animal" },
  { emojis: "🐱🦁🐯", terms: "cat kitten lion tiger feline pet animal" },
  { emojis: "🐭🐹🐰", terms: "mouse hamster rabbit bunny pet animal" },
  { emojis: "🐻🐼🐨", terms: "bear panda koala animal" },
  { emojis: "🐮🐷🐸🐵🐘", terms: "cow pig frog monkey elephant animal" },
  { emojis: "🐔🐧🐦🐤🦆🦅🦉🦇", terms: "chicken penguin bird chick duck eagle owl bat animal" },
  { emojis: "🐴🦄", terms: "horse pony unicorn animal" },
  { emojis: "🐝🐛🦋🐌🐞🐜🕷️", terms: "bee bug bugs butterfly snail ladybug ant spider insect animal" },
  { emojis: "🐢🐍🦎🦖", terms: "turtle snake lizard dinosaur reptile animal" },
  { emojis: "🐙🦑🦀🐠🐬🐳🦈", terms: "octopus squid crab fish dolphin whale shark ocean sea marine animal" },
  { emojis: "🐾", terms: "paw paws pet pets footprints animal" },
  { emojis: "🌱🌿🍀🌵🌲🌳🌴🌸🌻🪴", terms: "plant plants leaf clover lucky cactus tree palm flower blossom sunflower houseplant garden gardening green growth spring nature" },
  { emojis: "🍂", terms: "autumn fall leaves season nature" },
  { emojis: "🌞", terms: "sun sunny summer day weather" },
  { emojis: "🌙", terms: "moon night evening" },
  { emojis: "🌈", terms: "rainbow pride colors colours weather" },
  { emojis: "☁️", terms: "cloud cloudy weather" },
  { emojis: "⛈️", terms: "storm thunder lightning weather" },
  { emojis: "🌧️", terms: "rain rainy umbrella weather" },
  { emojis: "❄️", terms: "snow snowflake winter cold freeze weather" },
  { emojis: "💧", terms: "water drop droplet liquid" },
  { emojis: "🌊", terms: "ocean sea wave waves beach water" },
  { emojis: "🌍", terms: "world earth globe planet international global" },

  // Food & Drink
  { emojis: "🍏🍎🍐🍊🍋🍌🍉🍇🍓🫐🍒🍑🥭🍍🥥🥝", terms: "fruit apple pear orange lemon banana watermelon grape strawberry blueberry cherry peach mango pineapple coconut kiwi healthy food" },
  { emojis: "🍅🥑🥦🥕🌽🌶️", terms: "vegetable vegetables veggie tomato avocado broccoli carrot corn pepper chili spicy healthy food" },
  { emojis: "🥐🥯🍞🥨🧀🥚🍳🥞🥓", terms: "bread croissant bagel pretzel cheese egg eggs breakfast pancake bacon bakery cooking food" },
  { emojis: "🥩🍚", terms: "meat steak beef rice dinner meal food" },
  { emojis: "🍔🍟🍕🌭🥪🌮🌯🥗🍝🍜🍲🍣🍱🥟", terms: "burger fries pizza hot dog sandwich taco burrito salad pasta noodles soup sushi lunch dinner meal takeaway restaurant food" },
  { emojis: "🍦🍩🍪🎂🍰🍫🍿", terms: "ice cream donut cookie cake birthday chocolate popcorn dessert sweet baking food" },
  { emojis: "☕🍵", terms: "coffee tea cafe morning break drink" },
  { emojis: "🥛🥤🧃", terms: "milk soda juice drink" },
  { emojis: "🍺🍷🍸🍹🥂", terms: "beer wine cocktail alcohol bar pub cheers toast drink drinks" },
  { emojis: "🍽️🥄", terms: "plate cutlery spoon dinner meal eat restaurant recipe recipes cook cooking food" },

  // Travel & Places
  { emojis: "🚗🚕🚌🚎🏎️🚓🚑🚒🚚", terms: "car taxi bus race police ambulance fire truck drive driving commute transport vehicle" },
  { emojis: "🚲🛴🏍️", terms: "bike bicycle cycling scooter motorcycle transport vehicle" },
  { emojis: "🚂🚆🚇🚊", terms: "train railway subway metro tram commute transport travel" },
  { emojis: "✈️🚁", terms: "plane airplane flight flights fly airport helicopter trip travel" },
  { emojis: "🚀🛸", terms: "rocket launch release space ufo alien" },
  { emojis: "⛵🚢⚓", terms: "boat sail sailing ship cruise anchor sea travel" },
  { emojis: "⛽", terms: "fuel gas petrol station" },
  { emojis: "🚧", terms: "construction wip work in progress roadwork barrier" },
  { emojis: "🚦", terms: "traffic light signal" },
  { emojis: "🗺️🧭", terms: "map maps navigation directions compass route travel" },
  { emojis: "🗽", terms: "statue liberty new york landmark sightseeing travel" },
  { emojis: "🗼", terms: "tower paris eiffel tokyo landmark sightseeing travel" },
  { emojis: "🏰", terms: "castle landmark sightseeing travel" },
  { emojis: "🏯", terms: "japanese castle japan landmark sightseeing travel" },
  { emojis: "🏟️", terms: "stadium arena venue sport" },
  { emojis: "🎡🎢", terms: "fair amusement theme park ferris wheel rollercoaster fun" },
  { emojis: "🏠🏡", terms: "home house family personal household building" },
  { emojis: "🏢", terms: "office work company business corporate building" },
  { emojis: "🏫", terms: "school university college education class building" },
  { emojis: "🏥", terms: "hospital medical health doctor building" },
  { emojis: "🏦", terms: "bank finance money building" },
  { emojis: "🏨", terms: "hotel accommodation stay travel building" },
  { emojis: "🏪", terms: "shop store shopping building" },
  { emojis: "🏛️", terms: "museum government history building" },
  { emojis: "⛪🕌", terms: "church mosque religion faith worship building" },
  { emojis: "🏖️🏝️", terms: "beach island holiday vacation summer travel" },
  { emojis: "🏜️", terms: "desert" },
  { emojis: "🏔️⛰️🌋", terms: "mountain mountains hike hiking climbing volcano outdoors" },
  { emojis: "🏕️", terms: "camping camp tent outdoors" },
  { emojis: "🌃🌉", terms: "city night skyline bridge urban" },
  { emojis: "🧳", terms: "luggage suitcase packing trip holiday vacation travel" },

  // Activities
  { emojis: "⚽🥅", terms: "football soccer goal ball sport" },
  { emojis: "🏀", terms: "basketball ball sport" },
  { emojis: "🏈🏉", terms: "american football rugby ball sport" },
  { emojis: "⚾", terms: "baseball ball sport" },
  { emojis: "🎾", terms: "tennis ball sport" },
  { emojis: "🏐", terms: "volleyball ball sport" },
  { emojis: "🏓", terms: "ping pong table tennis sport" },
  { emojis: "🏸", terms: "badminton sport" },
  { emojis: "🏒🏑", terms: "hockey sport" },
  { emojis: "🏏", terms: "cricket sport" },
  { emojis: "⛳🏌️", terms: "golf sport" },
  { emojis: "🥏", terms: "frisbee sport" },
  { emojis: "🎱", terms: "pool billiards snooker ball" },
  { emojis: "🥍", terms: "lacrosse sport" },
  { emojis: "🪁", terms: "kite wind" },
  { emojis: "🏹", terms: "archery bow arrow sport" },
  { emojis: "🎣", terms: "fishing fish hobby" },
  { emojis: "🥊", terms: "boxing fight sport" },
  { emojis: "🥋", terms: "martial arts karate judo taekwondo sport" },
  { emojis: "🎽", terms: "running shirt marathon race sport" },
  { emojis: "🛹🛼", terms: "skateboard skateboarding skate skating roller sport" },
  { emojis: "⛸️", terms: "ice skating skate winter sport" },
  { emojis: "🎿⛷️🏂", terms: "ski skiing snowboard snowboarding snow winter sport" },
  { emojis: "🏋️", terms: "gym weights weightlifting workout fitness exercise sport" },
  { emojis: "🤸", terms: "gymnastics exercise sport" },
  { emojis: "🤾", terms: "handball sport" },
  { emojis: "🏄", terms: "surf surfing beach wave sport" },
  { emojis: "🚣", terms: "rowing boat sport" },
  { emojis: "🏊", terms: "swim swimming pool sport" },
  { emojis: "🎯", terms: "target goal goals aim focus darts" },
  { emojis: "🎮🕹️", terms: "game games gaming video controller joystick play" },
  { emojis: "🎲", terms: "dice board game games random" },
  { emojis: "🧩", terms: "puzzle jigsaw problem piece game" },
  { emojis: "♟️", terms: "chess strategy board game" },
  { emojis: "🎭", terms: "theater theatre drama acting performance" },
  { emojis: "🎨", terms: "art painting paint design creative artist" },
  { emojis: "🎬", terms: "movie movies film cinema video" },
  { emojis: "📺", terms: "tv television show shows series watch" },
  { emojis: "🎤🎙️", terms: "microphone mic sing karaoke podcast recording talk" },
  { emojis: "🎧", terms: "headphones listen audio music podcast" },
  { emojis: "🎼🎵", terms: "music song songs note melody" },
  { emojis: "🎹🥁🎷🎺🎸🎻", terms: "piano keyboard drum drums saxophone trumpet guitar violin instrument music band" },

  // Events & Planning
  { emojis: "🎈🎉🎊🪅🪩", terms: "balloon party celebrate celebration congrats confetti disco fun event" },
  { emojis: "🎁🎀", terms: "gift gifts present presents birthday ribbon" },
  { emojis: "🎆🎇🧨", terms: "fireworks sparkler new year celebration" },
  { emojis: "🎃", terms: "halloween pumpkin" },
  { emojis: "🎄🎅🤶🧑‍🎄", terms: "christmas xmas santa tree holiday" },
  { emojis: "🎋🎍🎎🎏🎐🎑", terms: "japanese festival japan" },
  { emojis: "🧧", terms: "red envelope lunar chinese new year gift money" },
  { emojis: "🎟️🎫", terms: "ticket tickets event concert show admission" },
  { emojis: "🏆🥇🥈🥉🏅🎖️", terms: "trophy medal award winner win prize achievement competition" },
  { emojis: "💐🌹", terms: "flowers flower bouquet rose valentine anniversary romance gift" },
  { emojis: "📅📆🗓️", terms: "calendar date dates schedule planning event events appointment meeting deadline due" },
  { emojis: "⏰⏱️⏲️⌚", terms: "clock alarm timer time watch stopwatch reminder deadline" },
  { emojis: "⏳", terms: "hourglass waiting wait pending time" },
  { emojis: "🗒️📓📔📕📗📘📙", terms: "note notes notebook journal diary book books" },
  { emojis: "🔖", terms: "bookmark saved" },
  { emojis: "📋", terms: "clipboard todo tasks task checklist list" },
  { emojis: "📊📈📉", terms: "chart charts graph stats statistics data report analytics dashboard trend growth metrics" },
  { emojis: "🧾", terms: "receipt invoice bill expense expenses" },
  { emojis: "📤📥", terms: "send sent receive inbox outbox upload download" },
  { emojis: "📦", terms: "box package parcel shipping delivery order" },
  { emojis: "✉️📧📮", terms: "mail email letter message inbox mailbox post" },
  { emojis: "💼", terms: "briefcase work job business" },
  { emojis: "🗃️🗄️", terms: "archive cabinet storage files filing records" },
  { emojis: "🗑️", terms: "trash bin rubbish garbage delete waste" },
  { emojis: "🛍️🛒", terms: "shopping shop buy groceries cart bag purchase" },

  // Objects
  { emojis: "💡", terms: "idea ideas light bulb tip insight brainstorm" },
  { emojis: "🔦🕯️", terms: "flashlight torch candle light" },
  { emojis: "🧯", terms: "extinguisher fire safety emergency" },
  { emojis: "🛠️🔧🔨🧰", terms: "tools tool wrench hammer toolbox fix repair maintenance diy build" },
  { emojis: "⚙️", terms: "gear settings config configuration options preferences" },
  { emojis: "🧲", terms: "magnet" },
  { emojis: "🔌🔋", terms: "plug power electric electricity charge charging battery energy" },
  { emojis: "🧪🧫🧬🔬", terms: "science lab experiment test tube dna biology chemistry microscope research" },
  { emojis: "🔭📡", terms: "telescope astronomy space antenna satellite signal science" },
  { emojis: "💉🩺💊", terms: "medicine injection vaccine doctor pill pills medication health medical" },
  { emojis: "🦷", terms: "tooth teeth dentist dental health" },
  { emojis: "🚪", terms: "door exit entrance" },
  { emojis: "🪑🛋️", terms: "chair sofa couch furniture seat" },
  { emojis: "🛏️", terms: "bed sleep bedroom" },
  { emojis: "🚿🧴", terms: "shower bathroom lotion skincare" },
  { emojis: "🧷🧵🪡", terms: "safety pin thread needle sewing knitting craft" },
  { emojis: "🧹🧼🧽🫧", terms: "clean cleaning tidy broom sweep soap sponge wash bubbles chore chores" },
  { emojis: "🧺👕", terms: "laundry basket clothes clothing shirt wardrobe" },
  { emojis: "🎒", terms: "backpack school bag" },
  { emojis: "🔑🗝️", terms: "key keys password login access credentials" },
  { emojis: "🔒🔐", terms: "lock locked private secure security password secret" },
  { emojis: "🔓", terms: "unlock unlocked open public" },
  { emojis: "🛡️", terms: "shield security protect protection safe" },
  { emojis: "💰💵", terms: "money cash finance budget savings dollar pay salary" },
  { emojis: "💳", terms: "card credit debit payment pay bank" },
  { emojis: "💎", terms: "diamond gem jewel valuable premium" },
  { emojis: "⚖️", terms: "balance scales law legal justice lawyer" },
  { emojis: "🧮", terms: "abacus math maths calculate accounting" },
  { emojis: "🪪", terms: "id identity card license licence badge" },
  { emojis: "📱", terms: "phone mobile cell app smartphone" },
  { emojis: "💻🖥️⌨️", terms: "laptop computer desktop monitor keyboard technology tech" },
  { emojis: "🖨️", terms: "printer print" },
  { emojis: "💾", terms: "save disk floppy storage backup" },
  { emojis: "📷", terms: "camera photo photos picture pictures image images photography" },
  { emojis: "🎥", terms: "video camera film recording" },
  { emojis: "📞☎️", terms: "phone telephone call calls contact" },
  { emojis: "🌐", terms: "web internet website online globe browser network" },
  { emojis: "🤖", terms: "robot bot ai automation llm machine" },
  { emojis: "📚", terms: "books library study reading research education learn" },
  { emojis: "📖", terms: "book read reading" },
  { emojis: "📝✏️", terms: "memo write writing notes note draft edit pencil" },
  { emojis: "📄", terms: "document page file paper doc" },
  { emojis: "📰", terms: "news newspaper article press" },
  { emojis: "📜", terms: "scroll history document certificate" },
  { emojis: "🎓", terms: "graduation education degree university college student learn" },
  { emojis: "📌", terms: "pin pinned important" },
  { emojis: "📍", terms: "location place address pin map" },
  { emojis: "✂️", terms: "scissors cut" },
  { emojis: "📎", terms: "paperclip attachment attach" },
  { emojis: "🔗", terms: "link links url web" },
  { emojis: "🏷️", terms: "tag tags label price" },
  { emojis: "📁🗂️", terms: "folder folders files directory project organize" },

  // Symbols
  { emojis: "❤️🧡💛💚💙💜🖤🤍💔", terms: "heart love like favorite favourite red orange yellow green blue purple black white broken" },
  { emojis: "✅☑️✔️", terms: "check tick done complete completed finished success yes ok approved" },
  { emojis: "❌❎✖️", terms: "cross no cancel fail failed wrong error delete close" },
  { emojis: "➕➖➗✖️", terms: "add plus minus subtract divide multiply math" },
  { emojis: "❗‼️", terms: "important exclamation urgent alert attention priority" },
  { emojis: "❓⁉️", terms: "question help unknown faq ask" },
  { emojis: "⚠️", terms: "warning caution danger risk alert" },
  { emojis: "🚫🛑", terms: "stop prohibited forbidden blocked ban no" },
  { emojis: "ℹ️", terms: "info information about details help" },
  { emojis: "🆕", terms: "new latest" },
  { emojis: "⭐🌟", terms: "star favorite favourite starred important rating" },
  { emojis: "✨💫", terms: "sparkle sparkles shiny magic new special clean" },
  { emojis: "🔥", terms: "fire flame hot trending urgent" },
  { emojis: "💥", terms: "boom explosion crash bang" },
  { emojis: "💯", terms: "hundred perfect score" },
  { emojis: "⚡", terms: "lightning bolt quick fast energy power electric zap" },
  { emojis: "📣", terms: "megaphone announce announcement news marketing" },
  { emojis: "🔔🔕", terms: "bell notification notifications reminder alert mute silent" },
  { emojis: "♻️", terms: "recycle recycling reuse environment green" },
  { emojis: "▶️⏸️", terms: "play pause start resume progress paused" },
  { emojis: "🔁🔄", terms: "repeat refresh sync update loop recurring reload arrow" },
  { emojis: "🔎", terms: "search find magnify zoom look research" },
  { emojis: "💬", terms: "chat comment comments message talk discussion speech conversation" },
  { emojis: "💭", terms: "thought thinking idea dream" },
  { emojis: "🔴🟠🟡🟢🔵🟣⚫⚪", terms: "circle dot red orange yellow green blue purple black white color colour status" },
  { emojis: "⬆️⬇️➡️⬅️↗️↘️↙️↖️🔙🔚🔜🔝", terms: "arrow up down right left back end soon top direction" },

  // Flags
  { emojis: "🏁", terms: "chequered checkered finish race done flag" },
  { emojis: "🚩", terms: "red warning issue flag" },
  { emojis: "🎌", terms: "crossed japan flag" },
  { emojis: "🏴", terms: "black flag" },
  { emojis: "🏳️", terms: "white surrender flag" },
  { emojis: "🏳️‍🌈", terms: "rainbow pride lgbt flag" },
  { emojis: "🇺🇸", terms: "usa us america united states american flag" },
  { emojis: "🇬🇧", terms: "uk britain united kingdom england british flag" },
  { emojis: "🇪🇺", terms: "eu europe european union flag" },
  { emojis: "🇮🇹", terms: "italy italian flag" },
  { emojis: "🇫🇷", terms: "france french flag" },
  { emojis: "🇩🇪", terms: "germany german flag" },
  { emojis: "🇪🇸", terms: "spain spanish flag" },
  { emojis: "🇵🇹", terms: "portugal portuguese flag" },
  { emojis: "🇳🇱", terms: "netherlands holland dutch flag" },
  { emojis: "🇨🇭", terms: "switzerland swiss flag" },
  { emojis: "🇸🇪", terms: "sweden swedish flag" },
  { emojis: "🇳🇴", terms: "norway norwegian flag" },
  { emojis: "🇩🇰", terms: "denmark danish flag" },
  { emojis: "🇫🇮", terms: "finland finnish flag" },
  { emojis: "🇮🇪", terms: "ireland irish flag" },
  { emojis: "🇬🇷", terms: "greece greek flag" },
  { emojis: "🇹🇷", terms: "turkey turkish türkiye flag" },
  { emojis: "🇹🇭", terms: "thailand thai flag" },
  { emojis: "🇯🇵", terms: "japan japanese flag" },
  { emojis: "🇰🇷", terms: "korea south korean flag" },
  { emojis: "🇨🇳", terms: "china chinese flag" },
  { emojis: "🇮🇳", terms: "india indian flag" },
  { emojis: "🇦🇺", terms: "australia australian flag" },
  { emojis: "🇳🇿", terms: "new zealand nz flag" },
  { emojis: "🇨🇦", terms: "canada canadian flag" },
  { emojis: "🇲🇽", terms: "mexico mexican flag" },
  { emojis: "🇧🇷", terms: "brazil brazilian flag" },
  { emojis: "🇦🇷", terms: "argentina argentinian flag" },
  { emojis: "🇿🇦", terms: "south africa african flag" },
  { emojis: "🇺🇦", terms: "ukraine ukrainian flag" },
];

// Split into whole emoji: a substring test would give 💻 the terms of 🧑‍💻 and 🏳️ those of 🏳️‍🌈.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function splitEmoji(emojis: string): Array<string> {
  return Array.from(segmenter.segment(emojis), s => s.segment);
}

function words(text: string): Array<string> {
  return text.toLocaleLowerCase().split(/\s*&\s*|\s+/).filter(Boolean);
}

const WORDS_BY_EMOJI = new Map<string, Array<string>>();
for (const group of EMOJI_SEARCH_GROUPS) {
  for (const emoji of splitEmoji(group.emojis)) {
    WORDS_BY_EMOJI.set(emoji, [...(WORDS_BY_EMOJI.get(emoji) ?? []), ...words(group.terms)]);
  }
}

/**
 * Each query word must match the start of one of the emoji's words or its category's words, or be part of the emoji
 * itself (for a pasted emoji). Matching only word starts keeps short queries precise: "ice" should find ice cream, not
 * office, police and dice.
 */
export function filterEmojiCategories(query: string): Array<EmojiCategory> {
  const queryWords = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length == 0) { return EMOJI_CATEGORIES; }
  const startsAny = (candidates: Array<string>, q: string) => candidates.some(w => w.startsWith(q));
  return EMOJI_CATEGORIES.map(category => {
    const categoryWords = words(category.name);
    return {
      ...category,
      emojis: category.emojis.filter(emoji => {
        const emojiWords = WORDS_BY_EMOJI.get(emoji) ?? [];
        return queryWords.every(q => emoji.includes(q) || startsAny(emojiWords, q) || startsAny(categoryWords, q));
      }),
    };
  }).filter(category => category.emojis.length > 0);
}
