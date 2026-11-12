// Prompts should have a few "obvious" answers so people can converge, but not just one.
export const PROMPTS = [
  // Food & drink
  'A breakfast food', 'A pizza topping', 'A fruit that is red', 'Something you put on toast',
  'A flavor of ice cream', 'A snack at the movies', 'A food that is often fried',
  'Something people put in coffee', 'A type of pasta', 'A vegetable kids hate',
  'A cereal brand', 'Something on a cheese board', 'A food you eat with chopsticks',
  'A drink with bubbles', 'Something in a salad', 'A soup', 'A sandwich ingredient',
  'A type of bread', 'A spicy food', 'A dessert at a birthday party', 'A food at a barbecue',
  'A candy bar', 'A nut', 'A citrus fruit', 'A berry', 'Something you dip in ketchup',
  // Animals & nature
  'An animal at a farm', 'A pet that is not a cat or dog', 'An animal with stripes',
  'A bird', 'A sea creature', 'An insect', 'A big cat', 'An animal that hops',
  'A tree', 'A flower', 'Something you see at the beach', 'A type of weather',
  'A planet', 'A gemstone', 'Something that glows in the dark', 'An animal in the jungle',
  'A dog breed', 'An animal that lives in a shell', 'Something found in a forest',
  // Home & everyday
  'Something in a kitchen drawer', 'Something in a bathroom', 'A piece of furniture',
  'Something you find under a couch', 'Something in a junk drawer', 'A household chore',
  'Something you plug in', 'Something in a backpack', 'Something on a desk',
  'Something you lose often', 'Something in a first aid kit', 'A thing with buttons',
  'Something that has a lid', 'Something you sharpen', 'A room in a house',
  'Something in a toolbox', 'Something that is always cold', 'Something you fold',
  'Something that needs batteries', 'Something you water',
  // People & places
  'A job that requires a uniform', 'A famous painter', 'A country in Europe',
  'A city people take honeymoons in', 'A famous scientist', 'A US state',
  'Something at an airport', 'Something at a wedding', 'Something at a hospital',
  'A place you need a ticket for', 'Something in a classroom', 'A sport played with a ball',
  'An Olympic sport', 'A board game', 'A card game', 'A musical instrument',
  'Something at a playground', 'Something at a campsite', 'A type of shop at a mall',
  'A place you whisper', 'Something at a gym', 'A famous landmark',
  // Pop culture & fun
  'A superhero', 'A fairy tale character', 'A cartoon dog', 'A holiday',
  'A song everyone knows the words to', 'A dance move', 'A magic trick prop',
  'A word that rhymes with "cat"', 'A color', 'A shape', 'A number between 1 and 10',
  'A day of the week', 'A month', 'Something with wheels', 'A mode of transport',
  'Something that flies', 'A Halloween costume', 'A Christmas decoration',
  'Something in a fairy tale', 'A famous wizard', 'Something pirates have',
  'Something knights have', 'Something a detective uses', 'Something in space',
  'A dinosaur', 'A mythical creature', 'A video game console', 'A social media app',
  'A streaming service', 'An emoji people overuse', 'A computer key',
  // Abstract & feelings
  'Something that makes you sleepy', 'Something that smells good', 'Something that is loud',
  'Something soft', 'Something sticky', 'Something that is round', 'Something that is yellow',
  'Something that is green', 'Something that is tiny', 'Something that is heavy',
  'Something that is hot', 'Something you count', 'Something you can recycle',
  'Something people collect', 'A reason to be late', 'A New Year\'s resolution',
  'Something you do on a rainy day', 'A hobby', 'A good gift for a teacher',
  'Something you save for later', 'A thing you\'d bring to a desert island',
  'Something that makes noise at night', 'A smell that reminds you of childhood',
  'A word people often misspell', 'An excuse for not doing homework',
  'Something you say when you answer the phone', 'A way to say goodbye',
  'Something people are afraid of', 'Something that comes in pairs',
  'Something with a tail', 'Something with a handle', 'Something that is striped',
  'A word that starts with "Z"', 'Something that melts', 'Something that bounces',
  'Something you see in the sky', 'A sound a clock makes',
  'Something you do before bed', 'Something you do every morning',
  'Something you can\'t live without', 'A famous duo', 'A thing with keys',
  'Something that is orange', 'A thing you wrap', 'Something that has pages',
];

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
