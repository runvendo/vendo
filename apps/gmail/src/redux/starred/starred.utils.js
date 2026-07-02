export const addStarToList = (starToAdd, starList) => {
  const existingList = starList.find((star) => star.id === starToAdd.id);

  if (existingList) {
    return starList.map((star) => (star.id === starToAdd.id ? star : star));
  }

  return [{ ...starToAdd, quantity: 1 }, ...starList];
};

export const removeStarredFromList = (starList, starToRemove) => {
  const existingList = starList.find((star) => star.id === starToRemove.id);

  if (existingList) {
    return starList.filter((star) => star.id !== starToRemove.id);
  }

  return starList;
};
